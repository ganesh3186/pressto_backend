import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {
  get,
  HttpErrors,
  param,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {PickupHandoverStatus} from '../models/pickup-handover-status.enum';
import {PickupHandoverTargetType} from '../models/pickup-handover-target-type.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {
  BagRepository,
  ItemCategoryRepository,
  PickupHandoverItemRepository,
  PickupHandoverRepository,
  PickupRequestRepository,
  RiderRepository,
  ServiceCategoryRepository,
  ServiceRepository,
  StoreRepository,
} from '../repositories';

/**
 * Rider-facing "Handover orders" APIs — the garment-side twin of
 * RiderDeliveryController's cash-handover endpoints. A rider batches
 * several of their own PICKED_UP pickup requests, picks who it's going to
 * (a store, or another rider/van), and gets back a handoverCode to show as
 * a QR + text. Confirmation is QR/code-based, not tap-to-confirm: the
 * receiver resolves by that code, not by knowing an id up front.
 *
 * A store-targeted batch is confirmed by store staff scanning the code on
 * the admin panel (PickupHandoverController.confirm, pickup-handover.
 * controller.ts). A rider-targeted one is confirmed here, by the
 * receiving rider — same split as cash handover's admin-vs-rider confirm.
 */
export class RiderPickupHandoverController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(PickupHandoverRepository)
    private pickupHandoverRepository: PickupHandoverRepository,
    @repository(PickupHandoverItemRepository)
    private pickupHandoverItemRepository: PickupHandoverItemRepository,
    @repository(StoreRepository) private storeRepository: StoreRepository,
    @repository(ItemCategoryRepository)
    private itemCategoryRepository: ItemCategoryRepository,
    @repository(ServiceCategoryRepository)
    private serviceCategoryRepository: ServiceCategoryRepository,
    @repository(ServiceRepository) private serviceRepository: ServiceRepository,
    @repository(BagRepository) private bagRepository: BagRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider)
      throw new HttpErrors.Forbidden(
        'This account is not registered as a rider.',
      );
    if (!rider.isActive)
      throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  // 6-digit numeric, unique among currently-PENDING batches only — a
  // confirmed/expired batch's code is free to be reused later.
  private async generateHandoverCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const existing = await this.pickupHandoverRepository.findOne({
        where: {
          handoverCode: code,
          status: PickupHandoverStatus.PENDING,
        } as object,
      });
      if (!existing) return code;
    }
    throw new HttpErrors.InternalServerError(
      'Could not generate a unique handover code.',
    );
  }

  // ─── Eligible pickups (picked up, not already in a pending batch) ────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-requests/handover-eligible')
  @response(200, {
    description:
      "The rider's own picked-up requests not yet in a pending handover batch",
  })
  async handoverEligible(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const pickups = await this.pickupRequestRepository.find({
      where: {
        assignedRiderId: rider.id,
        isDeleted: false,
        status: PickupRequestStatus.PICKED_UP,
      } as object,
      order: ['updatedAt DESC'],
    });
    if (!pickups.length) return {pickupRequests: []};

    const pendingHandovers = await this.pickupHandoverRepository.find({
      where: {
        riderId: rider.id,
        isDeleted: false,
        status: PickupHandoverStatus.PENDING,
      } as object,
      fields: {id: true} as object,
    });
    const pendingHandoverIds = pendingHandovers.map(h => h.id);
    const batchedItems = pendingHandoverIds.length
      ? await this.pickupHandoverItemRepository.find({
          where: {pickupHandoverId: {inq: pendingHandoverIds}} as object,
          fields: {pickupRequestId: true} as object,
        })
      : [];
    const batchedIds = new Set(batchedItems.map(i => i.pickupRequestId));
    const eligible = pickups.filter(p => !batchedIds.has(p.id));

    // The store this pickup belongs to — the rider needs to know where
    // they're taking it, not just what's in the bag.
    const storeIds = [
      ...new Set(
        eligible.map(p => p.storeId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const stores = storeIds.length
      ? await this.storeRepository.find({
          where: {id: {inq: storeIds}} as object,
        })
      : [];
    const storeById = new Map(stores.map(s => [s.id, s]));

    // Resolve display values in batches so the rider app never has to show
    // raw foreign-key UUIDs or make one master-data request per row.
    const categoryIds = [
      ...new Set(
        eligible
          .flatMap(p =>
            (p.itemCategoryEstimate ?? []).map(line => line.itemCategoryId),
          )
          .filter(Boolean),
      ),
    ];
    const serviceIds = [
      ...new Set(
        eligible
          .flatMap(p => [
            ...(p.itemCategoryEstimate ?? []).map(line => line.serviceId),
            ...(p.actualItemsByService ?? []).map(line => line.serviceId),
          ])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const bagIds = [
      ...new Set(
        eligible
          .flatMap(p => [
            p.bagId,
            ...(p.actualItemsByService ?? []).map(line => line.bagId),
          ])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const [itemCategories, serviceCategories, services, bags] =
      await Promise.all([
        categoryIds.length
          ? this.itemCategoryRepository.find({
              where: {id: {inq: categoryIds}} as object,
            })
          : [],
        categoryIds.length
          ? this.serviceCategoryRepository.find({
              where: {id: {inq: categoryIds}} as object,
            })
          : [],
        serviceIds.length
          ? this.serviceRepository.find({
              where: {id: {inq: serviceIds}} as object,
            })
          : [],
        bagIds.length
          ? this.bagRepository.find({where: {id: {inq: bagIds}} as object})
          : [],
      ]);
    const categoryNameById = new Map([
      ...serviceCategories.map(
        category => [category.id, category.name] as const,
      ),
      ...itemCategories.map(category => [category.id, category.name] as const),
    ]);
    const serviceNameById = new Map(
      services.map(service => [service.id, service.name]),
    );
    const bagNumberById = new Map(bags.map(bag => [bag.id, bag.bagNumber]));

    return {
      pickupRequests: eligible.map(p => ({
        ...p,
        store: p.storeId ? this.toStoreSummary(storeById.get(p.storeId)) : null,
        bagNumber: p.bagId ? (bagNumberById.get(p.bagId) ?? null) : null,
        itemCategoryEstimate: (p.itemCategoryEstimate ?? []).map(line => ({
          ...line,
          itemCategoryName: categoryNameById.get(line.itemCategoryId) ?? null,
          serviceName: line.serviceId
            ? (serviceNameById.get(line.serviceId) ?? null)
            : null,
        })),
        actualItemsByService: (p.actualItemsByService ?? []).map(line => ({
          ...line,
          serviceName:
            line.serviceName || serviceNameById.get(line.serviceId) || null,
          bagNumber: line.bagId
            ? (bagNumberById.get(line.bagId) ?? null)
            : null,
        })),
      })),
    };
  }

  // Consistent, trimmed shape for "which store" info handed to a rider —
  // shared by handover-eligible (pickup's own store) and, on the cash side,
  // RiderDeliveryController's pendingCashItems (the delivered order's
  // store).
  private toStoreSummary(store?: {
    id: string;
    name: string;
    code: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    phone?: string;
  }) {
    if (!store) return null;
    return {
      id: store.id,
      name: store.name,
      code: store.code,
      address: store.address,
      city: store.city,
      state: store.state,
      pincode: store.pincode,
      phone: store.phone ?? null,
    };
  }

  // ─── Submit a handover batch ──────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/pickup-handovers')
  @response(200, {
    description:
      'Pickup handover batch submitted, with a code to show the receiver',
  })
  async submitHandover(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['pickupRequestIds', 'handoverToType'],
            properties: {
              pickupRequestIds: {
                type: 'array',
                minItems: 1,
                items: {type: 'string', format: 'uuid'},
              },
              handoverToType: {
                type: 'string',
                enum: Object.values(PickupHandoverTargetType),
              },
              handoverToStoreId: {
                type: 'string',
                format: 'uuid',
                description: 'Required when handoverToType is "store".',
              },
              handoverToRiderId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Required when handoverToType is "rider" — covers both "Van" and "Rider" in the app UI.',
              },
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      pickupRequestIds: string[];
      handoverToType: PickupHandoverTargetType;
      handoverToStoreId?: string;
      handoverToRiderId?: string;
      remarks?: string;
    },
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const pickups = await this.pickupRequestRepository.find({
      where: {id: {inq: body.pickupRequestIds}} as object,
    });
    if (pickups.length !== body.pickupRequestIds.length) {
      throw new HttpErrors.NotFound(
        'One or more pickup requests were not found.',
      );
    }
    const invalid = pickups.filter(
      p =>
        p.assignedRiderId !== rider.id ||
        p.status !== PickupRequestStatus.PICKED_UP,
    );
    if (invalid.length) {
      throw new HttpErrors.BadRequest(
        'One or more pickup requests are not yours to hand over, or not picked up yet.',
      );
    }

    const alreadyBatchedItems = await this.pickupHandoverItemRepository.find({
      where: {pickupRequestId: {inq: body.pickupRequestIds}} as object,
      fields: {pickupHandoverId: true, pickupRequestId: true} as object,
    });
    if (alreadyBatchedItems.length) {
      const activeHandovers = await this.pickupHandoverRepository.find({
        where: {
          id: {
            inq: [...new Set(alreadyBatchedItems.map(i => i.pickupHandoverId))],
          },
          status: PickupHandoverStatus.PENDING,
        } as object,
        fields: {id: true} as object,
      });
      const activeHandoverIds = new Set(activeHandovers.map(h => h.id));
      if (
        alreadyBatchedItems.some(i => activeHandoverIds.has(i.pickupHandoverId))
      ) {
        throw new HttpErrors.BadRequest(
          'One or more pickup requests are already in a pending handover batch.',
        );
      }
    }

    let handoverToName: string;
    if (body.handoverToType === PickupHandoverTargetType.STORE) {
      if (!body.handoverToStoreId) {
        throw new HttpErrors.BadRequest(
          'handoverToStoreId is required when handoverToType is "store".',
        );
      }
      const targetStore = await this.storeRepository.findOne({
        where: {id: body.handoverToStoreId, isDeleted: false} as object,
      });
      if (!targetStore)
        throw new HttpErrors.NotFound('Target store not found.');
      handoverToName = targetStore.name;
    } else if (body.handoverToType === PickupHandoverTargetType.RIDER) {
      if (!body.handoverToRiderId) {
        throw new HttpErrors.BadRequest(
          'handoverToRiderId is required when handoverToType is "rider".',
        );
      }
      if (body.handoverToRiderId === rider.id) {
        throw new HttpErrors.BadRequest('Cannot hand these over to yourself.');
      }
      const targetRider = await this.riderRepository.findOne({
        where: {
          id: body.handoverToRiderId,
          isActive: true,
          isDeleted: false,
        } as object,
      });
      if (!targetRider)
        throw new HttpErrors.NotFound('Target rider not found or inactive.');
      handoverToName = `${targetRider.firstName} ${targetRider.lastName}`;
    } else {
      throw new HttpErrors.BadRequest(
        `Unknown handoverToType: ${body.handoverToType}.`,
      );
    }

    const {v4} = await import('uuid');
    const now = new Date();
    const seq = (await this.pickupHandoverRepository.count()).count + 1;
    const ddMM = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const handoverNumber = `PH-${rider.riderCode}-${ddMM}-${seq}`;
    const handoverCode = await this.generateHandoverCode();

    const tx = await this.dataSource.beginTransaction(
      IsolationLevel.READ_COMMITTED,
    );
    try {
      const handover = await this.pickupHandoverRepository.create(
        {
          id: v4(),
          handoverNumber,
          handoverCode,
          status: PickupHandoverStatus.PENDING,
          riderId: rider.id,
          riderName: `${rider.firstName} ${rider.lastName}`,
          riderCode: rider.riderCode,
          itemCount: pickups.length,
          handoverToType: body.handoverToType,
          handoverToStoreId: body.handoverToStoreId,
          handoverToRiderId: body.handoverToRiderId,
          handoverToName,
          submittedAt: now,
          submittedBy: currentUser[securityId],
          remarks: body.remarks,
        },
        {transaction: tx},
      );

      for (const p of pickups) {
        await this.pickupHandoverItemRepository.create(
          {
            id: v4(),
            pickupHandoverId: handover.id,
            pickupRequestId: p.id,
            pickupNumber: p.pickupNumber,
            customerName: p.customerName,
          },
          {transaction: tx},
        );
      }

      await tx.commit();
      return {message: 'Pickup handover submitted.', handover};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Own batch history ────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-handovers')
  @response(200, {description: "The rider's own pickup handover batch history"})
  async myHandovers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('status') status?: PickupHandoverStatus,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const handovers = await this.pickupHandoverRepository.find({
      where: {
        riderId: rider.id,
        isDeleted: false,
        ...(status ? {status} : {}),
      } as object,
      order: ['submittedAt DESC'],
    });
    const handoverIds = handovers.map(h => h.id);
    const items = handoverIds.length
      ? await this.pickupHandoverItemRepository.find({
          where: {pickupHandoverId: {inq: handoverIds}} as object,
        })
      : [];
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByHandover.get(item.pickupHandoverId) ?? [];
      list.push(item);
      itemsByHandover.set(item.pickupHandoverId, list);
    }

    return {
      handovers: handovers.map(h => ({
        ...h,
        items: itemsByHandover.get(h.id) ?? [],
      })),
    };
  }

  // ─── Handed to ME by another rider ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-handovers/incoming')
  @response(200, {
    description:
      'Pickup handover batches directed to the calling rider by another rider',
  })
  async incomingHandovers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('tab') tab?: 'pending' | 'completed',
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const handovers = await this.pickupHandoverRepository.find({
      where: {
        handoverToType: PickupHandoverTargetType.RIDER,
        handoverToRiderId: rider.id,
        isDeleted: false,
        status:
          tab === 'completed'
            ? PickupHandoverStatus.CONFIRMED
            : PickupHandoverStatus.PENDING,
      } as object,
      order: ['submittedAt DESC'],
    });
    const handoverIds = handovers.map(h => h.id);
    const items = handoverIds.length
      ? await this.pickupHandoverItemRepository.find({
          where: {pickupHandoverId: {inq: handoverIds}} as object,
        })
      : [];
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByHandover.get(item.pickupHandoverId) ?? [];
      list.push(item);
      itemsByHandover.set(item.pickupHandoverId, list);
    }

    return {
      handovers: handovers.map(h => ({
        ...h,
        items: itemsByHandover.get(h.id) ?? [],
      })),
    };
  }

  // ─── Confirm a batch handed to me (scan or manual code entry) ─────────────
  // Reassigns each linked PickupRequest to ME (assignedRiderId +
  // assignedRiderName) — status stays PICKED_UP, unchanged. Same
  // "custody moves on, doesn't just vanish" principle as the cash-handover
  // confirm: I'm a new custodian, not the final destination, so these
  // immediately reappear in MY OWN GET /rider/pickup-requests?tab=completed
  // and GET /rider/pickup-requests/handover-eligible, ready to be handed
  // off again.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/pickup-handovers/confirm')
  @response(200, {description: 'Pickup handover confirmed received'})
  async confirmIncomingHandover(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['code'],
            properties: {code: {type: 'string'}},
          },
        },
      },
    })
    body: {code: string},
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const handover = await this.pickupHandoverRepository.findOne({
      where: {handoverCode: body.code, isDeleted: false} as object,
    });
    if (!handover)
      throw new HttpErrors.NotFound('No handover found for this code.');
    if (
      handover.handoverToType !== PickupHandoverTargetType.RIDER ||
      handover.handoverToRiderId !== rider.id
    ) {
      throw new HttpErrors.Forbidden('This handover was not directed to you.');
    }
    if (handover.status !== PickupHandoverStatus.PENDING) {
      throw new HttpErrors.BadRequest(
        `This handover is already ${handover.status}.`,
      );
    }

    const items = await this.pickupHandoverItemRepository.find({
      where: {pickupHandoverId: handover.id} as object,
    });
    for (const item of items) {
      await this.pickupRequestRepository.updateById(item.pickupRequestId, {
        assignedRiderId: rider.id,
        assignedRiderName: `${rider.firstName} ${rider.lastName}`,
      });
    }

    await this.pickupHandoverRepository.updateById(handover.id, {
      status: PickupHandoverStatus.CONFIRMED,
      confirmedAt: new Date(),
      confirmedBy: currentUser[securityId],
    });

    return {message: 'Pickup handover confirmed received.'};
  }
}
