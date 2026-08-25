import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {BagStatus} from '../models/bag-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {TransferCustodyEventType} from '../models/transfer-custody-event-type.enum';
import {TransferItemScanStatus} from '../models/transfer-item-status.enum';
import {TransferStatus} from '../models/transfer-status.enum';
import {Transfer} from '../models/transfer.model';
import {Order} from '../models/order.model';
import {
  BagRepository,
  CustomerRepository,
  GarmentRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  RiderRepository,
  ServiceRepository,
  StoreRepository,
  TransferCustodyEventRepository,
  TransferItemRepository,
  TransferRepository,
  UsersRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

export class TransferController {
  constructor(
    @repository(TransferRepository) private transferRepo: TransferRepository,
    @repository(TransferItemRepository) private transferItemRepo: TransferItemRepository,
    @repository(TransferCustodyEventRepository) private custodyEventRepo: TransferCustodyEventRepository,
    @repository(BagRepository) private bagRepo: BagRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(RiderRepository) private riderRepo: RiderRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  // ─── Validation helpers ───────────────────────────────────────────────────

  private async assertBagAvailable(bagId: string) {
    const bag = await this.bagRepo.findOne({where: {id: bagId, isDeleted: false}});
    if (!bag) throw new HttpErrors.NotFound('Bag not found.');
    if (!bag.isActive) throw new HttpErrors.BadRequest('This bag is inactive.');
    if (bag.status !== BagStatus.AVAILABLE) {
      throw new HttpErrors.Conflict(
        `Bag ${bag.bagNumber} is already ${bag.status === BagStatus.FULL ? 'full' : 'in use'}.`,
      );
    }
    return bag;
  }

  // Every status before RECEIVED/DISCREPANCY is "still open, not yet at the
  // destination" — a garment scanned onto one of these must not also be
  // scannable into a second transfer.
  private static readonly OPEN_TRANSFER_STATUSES: TransferStatus[] = [
    TransferStatus.SENT,
    TransferStatus.RIDER_ASSIGNED,
    TransferStatus.IN_TRANSIT,
  ];

  /**
   * Blocks a garment already "in an active transfer": scanned on a still-open
   * transfer (sent/rider_assigned/in_transit — in flight), or missing on a
   * still-DISCREPANCY transfer (its whereabouts are unresolved — there's no
   * reconciliation endpoint this pass to clear that flag, so letting it back
   * into a fresh transfer would let the same physical item get "sent" twice
   * on paper). A RECEIVED transfer's items are free to move again.
   */
  private async assertGarmentsTransferable(garmentIds: string[]) {
    const garments = await this.garmentRepo.find({
      where: {id: {inq: garmentIds}, isDeleted: false} as object,
    });
    if (garments.length !== garmentIds.length) {
      throw new HttpErrors.NotFound('One or more garments were not found.');
    }

    const openItems = await this.transferItemRepo.find({
      where: {
        garmentId: {inq: garmentIds},
        scanStatus: {inq: [TransferItemScanStatus.SCANNED, TransferItemScanStatus.MISSING]},
      } as object,
    });
    if (!openItems.length) return garments;

    const parentIds = [...new Set(openItems.map(i => i.transferId))];
    const parents = await this.transferRepo.find({where: {id: {inq: parentIds}} as object});
    const parentById = new Map(parents.map(t => [t.id, t]));

    const blockedTags = new Set<string>();
    for (const item of openItems) {
      const parent = parentById.get(item.transferId);
      if (!parent) continue;
      const blocked =
        item.scanStatus === TransferItemScanStatus.SCANNED
          ? TransferController.OPEN_TRANSFER_STATUSES.includes(parent.status ?? TransferStatus.SENT)
          : item.scanStatus === TransferItemScanStatus.MISSING &&
            parent.status === TransferStatus.DISCREPANCY;
      if (blocked) blockedTags.add(item.garmentTagNumber);
    }
    if (blockedTags.size) {
      throw new HttpErrors.Conflict(`Already in an active transfer: ${[...blockedTags].join(', ')}.`);
    }
    return garments;
  }

  private async assertRiderAssignable(riderId: string) {
    const rider = await this.riderRepo.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    if (!rider.isActive) throw new HttpErrors.BadRequest('This rider is inactive.');
    return rider;
  }

  /**
   * Plain-language answer to "where are these garments right now" — the
   * whole point of tracking rider assignment/in-transit at all. Computed at
   * read time from status + the already-resolved store/rider names, not
   * stored, so it's never stale.
   */
  private buildLocationLabel(
    t: {status?: TransferStatus | string; riderName?: string | null},
    fromStoreName: string | null,
    toStoreName: string | null,
  ): string {
    const from = fromStoreName ?? 'origin store';
    const to = toStoreName ?? 'destination store';
    const rider = t.riderName ?? 'the rider';
    switch (t.status) {
      case TransferStatus.SENT:
        return `Packed at ${from}, awaiting rider`;
      case TransferStatus.RIDER_ASSIGNED:
        return `Rider assigned (${rider}), awaiting pickup at ${from}`;
      case TransferStatus.IN_TRANSIT:
        return `In transit with ${rider} → ${to}`;
      case TransferStatus.RECEIVED:
        return `Received at ${to}`;
      case TransferStatus.DISCREPANCY:
        return `Discrepancy at ${to} — awaiting resolution`;
      case TransferStatus.RESOLVED:
        return `Discrepancy resolved at ${to}`;
      default:
        return String(t.status ?? '');
    }
  }

  /**
   * Batch-resolve store names/codes + the per-bag breakdown for list/detail
   * display. Bag breakdown comes from TransferItem.bagId, grouped per
   * transfer — items written before multi-bag transfers existed have no
   * bagId, so those fall back to the parent Transfer's own singular bagId,
   * resolving to exactly the one bag they always had.
   */
  private async enrichTransfers(transfers: Transfer[]): Promise<object[]> {
    if (!transfers.length) return [];
    const storeIds = [...new Set(transfers.flatMap(t => [t.fromStoreId, t.toStoreId]))];
    const transferById = new Map(transfers.map(t => [t.id, t]));

    const [stores, items] = await Promise.all([
      this.storeRepo.find({where: {id: {inq: storeIds}} as object}),
      this.transferItemRepo.find({
        where: {transferId: {inq: transfers.map(t => t.id)}} as object,
        fields: {transferId: true, bagId: true} as object,
      }),
    ]);
    const storeById = new Map(stores.map(s => [s.id, s]));

    const bagCountByTransfer = new Map<string, Map<string, number>>();
    for (const item of items) {
      const bagId = item.bagId ?? transferById.get(item.transferId)?.bagId;
      if (!bagId) continue;
      const perTransfer = bagCountByTransfer.get(item.transferId) ?? new Map<string, number>();
      perTransfer.set(bagId, (perTransfer.get(bagId) ?? 0) + 1);
      bagCountByTransfer.set(item.transferId, perTransfer);
    }

    const allBagIds = [...new Set([...bagCountByTransfer.values()].flatMap(m => [...m.keys()]))];
    const bags = allBagIds.length
      ? await this.bagRepo.find({where: {id: {inq: allBagIds}} as object})
      : [];
    const bagById = new Map(bags.map(b => [b.id, b]));

    return transfers.map(t => {
      const fromStoreName = storeById.get(t.fromStoreId)?.name ?? null;
      const toStoreName = storeById.get(t.toStoreId)?.name ?? null;
      const bagCounts = bagCountByTransfer.get(t.id);
      const transferBags = bagCounts
        ? [...bagCounts.entries()].map(([bagId, itemCount]) => ({
            bagId,
            bagNumber: bagById.get(bagId)?.bagNumber ?? null,
            itemCount,
          }))
        : [];
      return {
        ...t,
        fromStoreName,
        fromStoreCode: storeById.get(t.fromStoreId)?.code ?? null,
        toStoreName,
        toStoreCode: storeById.get(t.toStoreId)?.code ?? null,
        bagNumber: transferBags[0]?.bagNumber ?? null,
        bags: transferBags,
        currentLocationLabel: this.buildLocationLabel(t, fromStoreName, toStoreName),
      };
    });
  }

  /**
   * Shared transaction body for both a fresh outbound transfer (create())
   * and a return-batch (returnBatch()) — same mechanics either way: mint a
   * transitId/transferOrderNumber, create the Transfer header + one
   * TransferItem per garment (tagged with which bag it's in) + the opening
   * custody events, lock every bag involved. Callers own their own
   * pre-checks (store validity, bag availability, which garments are
   * eligible) since those differ between the two flows.
   */
  private async _createAndSendTransfer(params: {
    currentUser: UserProfile;
    fromStoreId: string;
    toStoreId: string;
    fromStoreCode: string;
    toStoreCode: string;
    bags: {bagId: string; garmentIds: string[]; maxCapacity: number}[];
    garments: {id: string; garmentTagNumber: string; orderItemId: string}[];
    reason?: string;
    remarks?: string;
    returnOfTransferId?: string;
  }): Promise<{transfer: Transfer; items: object[]}> {
    const {currentUser, fromStoreId, toStoreId, bags, garments} = params;

    const bagIdByGarmentId = new Map<string, string>();
    for (const bag of bags) for (const gid of bag.garmentIds) bagIdByGarmentId.set(gid, bag.bagId);

    // Batch-resolve each garment's orderId via its orderItem — one inq, not N+1.
    const orderItemIds = [...new Set(garments.map(g => g.orderItemId))];
    const orderItems = await this.orderItemRepo.find({where: {id: {inq: orderItemIds}} as object});
    const orderIdByOrderItemId = new Map(orderItems.map(oi => [oi.id, oi.orderId]));

    const {v4} = await import('uuid');
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const ddMM = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.transferRepo.count();
    const seq = count.count + 1;
    const transferOrderNumber = `TO-${ym}-${String(seq).padStart(5, '0')}`;
    const transitId = `TR-${params.fromStoreCode}-${params.toStoreCode}-${ddMM}-${seq}`;

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const transfer = await this.transferRepo.create(
        {
          id: v4(),
          transitId,
          transferOrderNumber,
          status: TransferStatus.SENT,
          fromStoreId,
          toStoreId,
          // First/primary bag — kept for back-compat single-bag display.
          // The real per-bag breakdown is TransferItem.bagId (see bags[]).
          bagId: bags[0].bagId,
          reason: params.reason,
          remarks: params.remarks,
          sentAt: now,
          sentBy: currentUser[securityId],
          itemCount: garments.length,
          returnOfTransferId: params.returnOfTransferId,
        },
        {transaction: tx},
      );

      const items = [];
      for (const garment of garments) {
        items.push(
          await this.transferItemRepo.create(
            {
              id: v4(),
              transferId: transfer.id,
              garmentId: garment.id,
              garmentTagNumber: garment.garmentTagNumber,
              orderId: orderIdByOrderItemId.get(garment.orderItemId) ?? '',
              bagId: bagIdByGarmentId.get(garment.id),
              scanStatus: TransferItemScanStatus.SCANNED,
            },
            {transaction: tx},
          ),
        );
      }

      // One BAG_SCANNED event per bag (each bag really was scanned
      // separately) — ITEMS_MAPPED/SENT_OUT stay whole-transfer events,
      // no bagId, same as before multi-bag existed.
      for (const bag of bags) {
        await this.custodyEventRepo.create(
          {
            id: v4(),
            transferId: transfer.id,
            eventType: TransferCustodyEventType.BAG_SCANNED,
            bagId: bag.bagId,
            performedBy: currentUser[securityId],
          },
          {transaction: tx},
        );
      }
      for (const eventType of [TransferCustodyEventType.ITEMS_MAPPED, TransferCustodyEventType.SENT_OUT]) {
        await this.custodyEventRepo.create(
          {id: v4(), transferId: transfer.id, eventType, performedBy: currentUser[securityId]},
          {transaction: tx},
        );
      }

      for (const bag of bags) {
        const bagItemCount = bag.garmentIds.length;
        await this.bagRepo.updateById(
          bag.bagId,
          {
            status: bagItemCount >= bag.maxCapacity ? BagStatus.FULL : BagStatus.IN_USE,
            itemCount: bagItemCount,
            currentTransferId: transfer.id,
            currentStoreId: fromStoreId,
          },
          {transaction: tx},
        );
      }

      await tx.commit();
      return {transfer, items};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Eligible Items (for the Send Out screen) ────────────────────────────────
  // GET /orders only returns an aggregate item COUNT per order (see
  // OrderService.listOrders) — no garment tag numbers, no serviceId. The
  // Send Out screen's scan box and order-browse tiles both need real
  // garment-level data (garmentTagNumber, serviceId) to work at all, so
  // this is a dedicated bulk read scoped to one store's currently-in-house
  // orders. The frontend's own store-service-mapping eligibility filter
  // (buildTransferCandidateRows) runs client-side against this data — this
  // endpoint just makes real data available for it to filter, it does not
  // pre-filter itself.

  private static readonly ELIGIBLE_ORDER_STATUSES: OrderStatus[] = [
    OrderStatus.RECEIVED_AT_STORE,
    OrderStatus.IN_INSPECTION,
    OrderStatus.IN_PROCESS,
    OrderStatus.QUALITY_CHECK,
    OrderStatus.ON_HOLD,
  ];

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:create']})
  @get('/transfers/eligible-items')
  @response(200, {description: 'Orders + garment-level items at a store, eligible to transfer out'})
  async eligibleItems(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId: string,
  ): Promise<object> {
    if (!storeId) throw new HttpErrors.BadRequest('storeId query parameter is required.');

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, storeId)) {
      throw new HttpErrors.NotFound('Store not found.');
    }

    const homeOrders = await this.orderRepo.find({
      where: {
        storeId,
        isDeleted: false,
        status: {inq: TransferController.ELIGIBLE_ORDER_STATUSES},
      } as object,
      order: ['createdAt DESC'],
      limit: 100,
    });

    // Garments currently in this store's custody via an inbound transfer,
    // even though their order was booked elsewhere — same "custody grants
    // rights" rule store-scope.service.ts's assertGarmentEditable already
    // applies to editing a garment, applied here to outbound eligibility:
    // whoever currently holds a garment can send it onward.
    const inboundTransfers = await this.transferRepo.find({
      where: {
        toStoreId: storeId,
        status: {inq: [TransferStatus.RECEIVED, TransferStatus.RESOLVED]},
        isDeleted: false,
      } as object,
      fields: {id: true} as object,
    });
    const visitingGarments = inboundTransfers.length
      ? await this.garmentRepo.find({
          where: {activeTransferId: {inq: inboundTransfers.map(t => t.id)}, isDeleted: false} as object,
        })
      : [];

    let visitingOrders: Order[] = [];
    if (visitingGarments.length) {
      const visitingOrderItems = await this.orderItemRepo.find({
        where: {id: {inq: [...new Set(visitingGarments.map(g => g.orderItemId))]}} as object,
      });
      const visitingOrderIds = [...new Set(visitingOrderItems.map(oi => oi.orderId))];
      visitingOrders = visitingOrderIds.length
        ? await this.orderRepo.find({
            where: {
              id: {inq: visitingOrderIds},
              isDeleted: false,
              status: {inq: TransferController.ELIGIBLE_ORDER_STATUSES},
            } as object,
          })
        : [];
    }

    const orderById = new Map([...homeOrders, ...visitingOrders].map(o => [o.id, o]));
    const orders = [...orderById.values()];
    if (!orders.length) return {orders: []};

    const orderIds = orders.map(o => o.id);
    const [orderItems, customers] = await Promise.all([
      this.orderItemRepo.find({where: {orderId: {inq: orderIds}} as object}),
      this.customerRepo.find({where: {id: {inq: [...new Set(orders.map(o => o.customerId))]}} as object}),
    ]);

    const orderItemIds = orderItems.map(oi => oi.id);
    const allGarments = orderItemIds.length
      ? await this.garmentRepo.find({
          where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as object,
        })
      : [];

    // Keep only garments actually here right now: a home garment must not
    // itself be away, and a visiting garment must be visiting THIS store
    // specifically (its order can be merged in above for a different
    // reason — e.g. it also has other garments genuinely home here).
    const visitingGarmentIds = new Set(visitingGarments.map(g => g.id));
    const orderStoreById = new Map(orders.map(o => [o.id, o.storeId]));
    const orderIdByOrderItemId = new Map(orderItems.map(oi => [oi.id, oi.orderId]));
    const garments = allGarments.filter(g => {
      if (g.activeTransferId) return visitingGarmentIds.has(g.id);
      const orderId = orderIdByOrderItemId.get(g.orderItemId);
      return orderId ? orderStoreById.get(orderId) === storeId : false;
    });

    const serviceIds = [...new Set(orderItems.map(oi => oi.serviceId))];
    const itemIds = [...new Set(orderItems.map(oi => oi.itemId))];
    const [services, items] = await Promise.all([
      serviceIds.length ? this.serviceRepo.find({where: {id: {inq: serviceIds}} as object}) : [],
      itemIds.length ? this.itemRepo.find({where: {id: {inq: itemIds}} as object}) : [],
    ]);

    const orderItemById = new Map(orderItems.map(oi => [oi.id, oi]));
    const serviceById = new Map(services.map(s => [s.id, s]));
    const itemById = new Map(items.map(i => [i.id, i]));
    const customerById = new Map(customers.map(c => [c.id, c]));
    const garmentsByOrderId = new Map<string, typeof garments>();
    for (const garment of garments) {
      const orderItem = orderItemById.get(garment.orderItemId);
      if (!orderItem) continue;
      const list = garmentsByOrderId.get(orderItem.orderId) ?? [];
      list.push(garment);
      garmentsByOrderId.set(orderItem.orderId, list);
    }

    const result = orders
      .map(order => {
        const orderGarments = garmentsByOrderId.get(order.id) ?? [];
        const orderItemsList = orderGarments.map(garment => {
          const orderItem = orderItemById.get(garment.orderItemId);
          const service = orderItem ? serviceById.get(orderItem.serviceId) : undefined;
          const item = orderItem ? itemById.get(orderItem.itemId) : undefined;
          return {
            id: garment.id,
            garmentId: garment.id,
            garmentTagNumber: garment.garmentTagNumber,
            itemName: item?.name ?? 'Garment',
            serviceId: orderItem?.serviceId ?? null,
            serviceName: service?.name ?? 'Service',
          };
        });
        const customer = customerById.get(order.customerId);
        return {
          orderId: order.orderNumber ?? order.id,
          orderNumber: order.orderNumber,
          customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : 'Customer',
          orderType: order.orderType,
          createdAt: order.createdAt,
          items: orderItemsList,
        };
      })
      .filter(order => order.items.length > 0);

    return {orders: result};
  }

  // ─── Create + Send (atomic) ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:create']})
  @post('/transfers')
  @response(200, {description: 'Transfer created and sent'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['fromStoreId', 'toStoreId', 'garmentIds'],
            properties: {
              fromStoreId: {type: 'string', format: 'uuid'},
              toStoreId: {type: 'string', format: 'uuid'},
              // Single-bag shape (still supported): send bagId instead of
              // bags. Multi-bag shape: send bags[], each with its own
              // garmentIds — bagId is then omitted.
              bagId: {type: 'string', format: 'uuid'},
              bags: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['bagId', 'garmentIds'],
                  properties: {
                    bagId: {type: 'string', format: 'uuid'},
                    garmentIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
                  },
                },
              },
              reason: {type: 'string'},
              remarks: {type: 'string'},
              // Flat union of every bag's garmentIds — still required so a
              // single-bag caller's existing payload keeps working as-is.
              garmentIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {
      fromStoreId: string;
      toStoreId: string;
      bagId?: string;
      bags?: {bagId: string; garmentIds: string[]}[];
      reason?: string;
      remarks?: string;
      garmentIds: string[];
    },
  ): Promise<object> {
    if (body.fromStoreId === body.toStoreId) {
      throw new HttpErrors.BadRequest('From and to store must be different.');
    }
    const [fromStore, toStore] = await Promise.all([
      this.storeRepo.findOne({where: {id: body.fromStoreId, isDeleted: false}}),
      this.storeRepo.findOne({where: {id: body.toStoreId, isDeleted: false}}),
    ]);
    if (!fromStore) throw new HttpErrors.NotFound('From store not found.');
    if (!toStore) throw new HttpErrors.NotFound('To store not found.');

    // Normalize to one shape regardless of which the caller sent.
    const bagInputs: {bagId: string; garmentIds: string[]}[] =
      body.bags?.length ? body.bags : body.bagId ? [{bagId: body.bagId, garmentIds: body.garmentIds}] : [];
    if (!bagInputs.length) throw new HttpErrors.BadRequest('bagId or bags is required.');

    const seenGarmentIds = new Set<string>();
    const bags: {bagId: string; garmentIds: string[]; maxCapacity: number}[] = [];
    const bagNumberById = new Map<string, number>();
    for (const input of bagInputs) {
      const garmentIds = [...new Set(input.garmentIds)];
      for (const gid of garmentIds) {
        if (seenGarmentIds.has(gid)) {
          throw new HttpErrors.BadRequest('An item cannot be assigned to more than one bag.');
        }
        seenGarmentIds.add(gid);
      }
      const bag = await this.assertBagAvailable(input.bagId);
      if (garmentIds.length > (bag.maxCapacity ?? 25)) {
        throw new HttpErrors.BadRequest(`Bag ${bag.bagNumber} holds at most ${bag.maxCapacity} items.`);
      }
      bagNumberById.set(input.bagId, bag.bagNumber);
      bags.push({bagId: input.bagId, garmentIds, maxCapacity: bag.maxCapacity ?? 25});
    }

    const garments = await this.assertGarmentsTransferable([...seenGarmentIds]);

    const {transfer, items} = await this._createAndSendTransfer({
      currentUser,
      fromStoreId: body.fromStoreId,
      toStoreId: body.toStoreId,
      fromStoreCode: fromStore.code,
      toStoreCode: toStore.code,
      bags,
      garments,
      reason: body.reason,
      remarks: body.remarks,
    });
    const responseBags = bags.map(b => ({
      bagId: b.bagId,
      bagNumber: bagNumberById.get(b.bagId) ?? null,
      itemCount: b.garmentIds.length,
    }));
    return {
      message: 'Transfer created and sent.',
      transfer: {...transfer, bags: responseBags},
      items,
    };
  }

  // ─── Assign Rider ───────────────────────────────────────────────────────────
  // Mandatory step between create() and receive() — a transfer can no longer
  // be received straight out of SENT (see TransferStatus/
  // TRANSFER_STATUS_TRANSITIONS). The rider then marks themself in transit
  // via PATCH /rider/transfers/{id}/status (rider-transfer.controller.ts)
  // before receive() will accept it. Gated by transfer:update (manager
  // level), same posture as resolve-discrepancy — assigning who carries the
  // goods is an ops decision, not routine counter work.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:update']})
  @post('/transfers/{id}/assign-rider')
  @response(200, {description: 'Rider assigned to this transfer'})
  async assignRider(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['riderId'],
            properties: {riderId: {type: 'string', format: 'uuid'}},
          },
        },
      },
    })
    body: {riderId: string},
  ): Promise<object> {
    const transfer = await this.transferRepo.findOne({where: {id, isDeleted: false}});
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    const assignableFrom: TransferStatus[] = [TransferStatus.SENT, TransferStatus.RIDER_ASSIGNED];
    if (!assignableFrom.includes(transfer.status ?? TransferStatus.SENT)) {
      throw new HttpErrors.BadRequest(`Cannot assign a rider to a transfer that is ${transfer.status}.`);
    }

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, transfer.fromStoreId)) {
      throw new HttpErrors.NotFound('Transfer not found.');
    }

    const rider = await this.assertRiderAssignable(body.riderId);

    const {v4} = await import('uuid');
    const now = new Date();
    const riderName = `${rider.firstName} ${rider.lastName}`;
    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      await this.transferRepo.updateById(
        id,
        {
          status: TransferStatus.RIDER_ASSIGNED,
          riderId: rider.id,
          riderName,
          riderAssignedAt: now,
          riderAssignedBy: currentUser[securityId],
        },
        {transaction: tx},
      );
      await this.custodyEventRepo.create(
        {
          id: v4(),
          transferId: id,
          eventType: TransferCustodyEventType.RIDER_ASSIGNED,
          performedBy: currentUser[securityId],
          remarks: `Assigned to ${riderName}.`,
        },
        {transaction: tx},
      );
      await tx.commit();
      return {message: 'Rider assigned.', transfer: await this.transferRepo.findById(id)};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── TEST ONLY: mark in transit from the admin panel ───────────────────────
  // There is no rider-app repo in this workspace yet, so there's no real UI
  // for a rider to call PATCH /rider/transfers/{id}/status themselves.
  // This lets an admin simulate that one step so the receive() flow can be
  // exercised end-to-end without a rider JWT/OTP. Remove this endpoint (and
  // its admin-panel button) once a real rider app exists — it deliberately
  // bypasses the rider-ownership check that the real endpoint enforces.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:update']})
  @post('/transfers/{id}/test-mark-in-transit')
  @response(200, {description: 'TEST ONLY — transfer marked in transit without a real rider call'})
  async testMarkInTransit(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const transfer = await this.transferRepo.findOne({where: {id, isDeleted: false}});
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.status !== TransferStatus.RIDER_ASSIGNED) {
      throw new HttpErrors.BadRequest(
        `Cannot mark in transit a transfer that is ${transfer.status}, not rider_assigned.`,
      );
    }

    const now = new Date();
    await this.transferRepo.updateById(id, {
      status: TransferStatus.IN_TRANSIT,
      inTransitAt: now,
      inTransitBy: currentUser[securityId],
    });

    const {v4} = await import('uuid');
    await this.custodyEventRepo.create({
      id: v4(),
      transferId: id,
      eventType: TransferCustodyEventType.IN_TRANSIT,
      performedBy: currentUser[securityId],
      remarks: 'Marked in transit via admin test shortcut (no rider app yet).',
    });

    return {message: 'Transfer marked in transit (test).', transfer: await this.transferRepo.findById(id)};
  }

  // ─── Return Batch ───────────────────────────────────────────────────────────
  // Sends some (or all) of an already-RECEIVED/RESOLVED transfer's items back
  // to the store that originally sent them — a new, ordinary Transfer in the
  // reverse direction, just tagged with returnOfTransferId so the UI can
  // chain it back to its origin. Reuses the exact same send mechanics as a
  // fresh outbound transfer via _createAndSendTransfer.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:create']})
  @post('/transfers/{id}/return-batch')
  @response(200, {description: 'Return-batch transfer created and sent'})
  async returnBatch(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['bagId', 'garmentIds'],
            properties: {
              bagId: {type: 'string', format: 'uuid'},
              reason: {type: 'string'},
              remarks: {type: 'string'},
              garmentIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
            },
          },
        },
      },
    })
    body: {bagId: string; reason?: string; remarks?: string; garmentIds: string[]},
  ): Promise<object> {
    const original = await this.transferRepo.findOne({where: {id, isDeleted: false}});
    if (!original) throw new HttpErrors.NotFound('Transfer not found.');
    if (
      original.status !== TransferStatus.RECEIVED &&
      original.status !== TransferStatus.RESOLVED
    ) {
      throw new HttpErrors.BadRequest(
        `Cannot return items from a transfer that is still ${original.status}.`,
      );
    }

    // The store now holding the goods (original's destination) is the one
    // sending the return batch back to where they came from.
    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, original.toStoreId)) {
      throw new HttpErrors.NotFound('Transfer not found.');
    }

    const garmentIds = [...new Set(body.garmentIds)];
    const originalItems = await this.transferItemRepo.find({
      where: {transferId: id, garmentId: {inq: garmentIds}} as object,
    });
    const originalItemByGarmentId = new Map(originalItems.map(i => [i.garmentId, i]));
    const notOnManifest = garmentIds.filter(gid => !originalItemByGarmentId.has(gid));
    if (notOnManifest.length) {
      throw new HttpErrors.BadRequest(
        `Not part of this transfer's manifest: ${notOnManifest.join(', ')}.`,
      );
    }
    const notReceived = originalItems
      .filter(i => i.scanStatus !== TransferItemScanStatus.RECEIVED)
      .map(i => i.garmentTagNumber);
    if (notReceived.length) {
      throw new HttpErrors.BadRequest(
        `Not marked received on this transfer, cannot return: ${notReceived.join(', ')}.`,
      );
    }

    // Block garments already covered by an earlier return batch of this
    // same origin transfer, whatever that batch's own outcome was.
    const priorBatches = await this.transferRepo.find({
      where: {returnOfTransferId: id} as object,
      fields: {id: true} as object,
    });
    if (priorBatches.length) {
      const priorItems = await this.transferItemRepo.find({
        where: {transferId: {inq: priorBatches.map(t => t.id)}, garmentId: {inq: garmentIds}} as object,
      });
      if (priorItems.length) {
        throw new HttpErrors.Conflict(
          `Already covered by an earlier return batch: ${priorItems.map(i => i.garmentTagNumber).join(', ')}.`,
        );
      }
    }

    const [fromStore, toStore] = await Promise.all([
      this.storeRepo.findOne({where: {id: original.toStoreId, isDeleted: false}}),
      this.storeRepo.findOne({where: {id: original.fromStoreId, isDeleted: false}}),
    ]);
    if (!fromStore || !toStore) throw new HttpErrors.NotFound('Store not found.');

    const bag = await this.assertBagAvailable(body.bagId);
    if (garmentIds.length > (bag.maxCapacity ?? 25)) {
      throw new HttpErrors.BadRequest(`This bag holds at most ${bag.maxCapacity} items.`);
    }
    const garments = await this.garmentRepo.find({
      where: {id: {inq: garmentIds}, isDeleted: false} as object,
    });

    const {transfer, items} = await this._createAndSendTransfer({
      currentUser,
      fromStoreId: original.toStoreId,
      toStoreId: original.fromStoreId,
      fromStoreCode: fromStore.code,
      toStoreCode: toStore.code,
      bags: [{bagId: body.bagId, garmentIds, maxCapacity: bag.maxCapacity ?? 25}],
      garments,
      reason: body.reason,
      remarks: body.remarks,
      returnOfTransferId: id,
    });
    return {
      message: 'Return batch created and sent.',
      transfer: {...transfer, bags: [{bagId: body.bagId, bagNumber: bag.bagNumber, itemCount: garmentIds.length}]},
      items,
    };
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/transfers')
  @response(200, {description: 'Transfers, filtered by direction/status/store/date'})
  async find(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('direction') direction?: string,
    @param.query.string('status') status?: TransferStatus,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});

    const and: object[] = [{isDeleted: false}];
    if (status) and.push({status});
    if (dateFrom ?? dateTo) {
      and.push({
        createdAt: {
          ...(dateFrom ? {gte: new Date(dateFrom)} : {}),
          ...(dateTo ? {lte: new Date(dateTo)} : {}),
        },
      });
    }
    if (narrowedStoreIds) {
      if (direction === 'outgoing') and.push({fromStoreId: {inq: narrowedStoreIds}});
      else if (direction === 'incoming') and.push({toStoreId: {inq: narrowedStoreIds}});
      else {
        and.push({
          or: [{fromStoreId: {inq: narrowedStoreIds}}, {toStoreId: {inq: narrowedStoreIds}}],
        });
      }
    }

    const transfers = await this.transferRepo.find({where: {and} as object, order: ['createdAt DESC']});
    return {transfers: await this.enrichTransfers(transfers)};
  }

  // ─── Summary Stats ──────────────────────────────────────────────────────────
  // Real counts only — no "overdue"/"nearing deadline" metric, since no
  // SLA/TAT rule exists anywhere in the system yet to define one (that's a
  // broader business decision, not specific to Transfer). Scoped the same
  // way as find(): store-scoped callers see only transfers touching their
  // stores.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/transfers/stats')
  @response(200, {description: 'Summary counts for the All Transfers screen'})
  async stats(@inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {});

    const and: object[] = [{isDeleted: false}];
    if (narrowedStoreIds) {
      and.push({or: [{fromStoreId: {inq: narrowedStoreIds}}, {toStoreId: {inq: narrowedStoreIds}}]});
    }

    const transfers = await this.transferRepo.find({
      where: {and} as object,
      fields: {status: true, sentAt: true, receivedAt: true} as object,
    });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    return {
      stats: {
        total: transfers.length,
        sent: transfers.filter(t => t.status === TransferStatus.SENT).length,
        riderAssigned: transfers.filter(t => t.status === TransferStatus.RIDER_ASSIGNED).length,
        inTransit: transfers.filter(t => t.status === TransferStatus.IN_TRANSIT).length,
        received: transfers.filter(t => t.status === TransferStatus.RECEIVED).length,
        discrepancy: transfers.filter(t => t.status === TransferStatus.DISCREPANCY).length,
        resolved: transfers.filter(t => t.status === TransferStatus.RESOLVED).length,
        sentToday: transfers.filter(t => t.sentAt && new Date(t.sentAt) >= startOfToday).length,
        receivedToday: transfers.filter(t => t.receivedAt && new Date(t.receivedAt) >= startOfToday)
          .length,
      },
    };
  }

  // ─── Detail ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/transfers/{id}')
  @response(200, {description: 'Transfer detail with items and custody trail'})
  async findById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    // Accept either the real uuid or the human-readable transitId (the
    // frontend's transit-details route is keyed by transitId, not id) —
    // same dual-lookup posture as GarmentController.lookupGarment, so a
    // non-uuid value resolves cleanly instead of Postgres throwing on a
    // malformed uuid literal.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(id.trim());
    const transfer = await this.transferRepo.findOne({
      where: isUuid ? {id, isDeleted: false} : {transitId: id.trim(), isDeleted: false},
    });
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');

    const scope = await this.storeScopeService.resolve(currentUser);
    if (
      !scope.global &&
      !this.storeScopeService.allows(scope, transfer.fromStoreId) &&
      !this.storeScopeService.allows(scope, transfer.toStoreId)
    ) {
      throw new HttpErrors.NotFound('Transfer not found.');
    }

    const [items, custodyEvents] = await Promise.all([
      this.transferItemRepo.find({where: {transferId: transfer.id} as object}),
      this.custodyEventRepo.find({where: {transferId: transfer.id} as object, order: ['performedAt ASC']}),
    ]);

    const orderIds = [...new Set(items.map(i => i.orderId))];
    const orders = orderIds.length
      ? await this.orderRepo.find({where: {id: {inq: orderIds}} as object})
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    const [enriched] = await this.enrichTransfers([transfer]);

    // Return batches sent back against this transfer (see returnBatch()) —
    // only ever non-empty for a RECEIVED/RESOLVED transfer, but cheap to
    // query unconditionally rather than special-casing by status here.
    const returnBatches = await this.transferRepo.find({
      where: {returnOfTransferId: transfer.id, isDeleted: false} as object,
      order: ['createdAt DESC'],
    });

    return {
      transfer: enriched,
      items: items.map(item => ({...item, orderNumber: orderById.get(item.orderId)?.orderNumber ?? null})),
      custodyEvents,
      returnBatches: await this.enrichTransfers(returnBatches),
    };
  }

  // ─── Receive ────────────────────────────────────────────────────────────────
  // Requires IN_TRANSIT — rider assignment is mandatory, so a transfer can
  // no longer be received straight out of SENT/RIDER_ASSIGNED. Bag releases
  // ONLY on a clean receive. A discrepant transfer keeps its bag locked —
  // there is no resolution endpoint this pass to clear a discrepancy and
  // free a stuck bag afterward. Known limitation; a follow-up pass owns
  // fixing it.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:create']})
  @post('/transfers/{id}/receive')
  @response(200, {description: 'Transfer received (clean or with discrepancies)'})
  async receive(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['receivedGarmentIds'],
            properties: {
              receivedGarmentIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              extraGarmentTagNumbers: {type: 'array', items: {type: 'string'}},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {receivedGarmentIds: string[]; extraGarmentTagNumbers?: string[]; remarks?: string},
  ): Promise<object> {
    const transfer = await this.transferRepo.findOne({where: {id, isDeleted: false}});
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.status !== TransferStatus.IN_TRANSIT) {
      throw new HttpErrors.BadRequest(
        `Cannot receive a transfer that is ${transfer.status} — it must be in_transit first.`,
      );
    }

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, transfer.toStoreId)) {
      throw new HttpErrors.NotFound('Transfer not found.');
    }

    const receivedIds = new Set(body.receivedGarmentIds ?? []);
    const items = await this.transferItemRepo.find({where: {transferId: id} as object});

    const {v4} = await import('uuid');
    const now = new Date();
    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      let receivedCount = 0;
      let missingCount = 0;
      // Every garment actually confirmed present — normally-matched
      // RECEIVED items and newly-created EXTRA items alike (both are a
      // real garment now physically at this store) — gets a dual-access
      // grant/clear applied below, independent of whether the transfer
      // overall ends up clean or discrepant.
      const presentGarments: {garmentId: string; orderId: string}[] = [];
      for (const item of items) {
        const isReceived = receivedIds.has(item.garmentId);
        await this.transferItemRepo.updateById(
          item.id,
          {scanStatus: isReceived ? TransferItemScanStatus.RECEIVED : TransferItemScanStatus.MISSING},
          {transaction: tx},
        );
        if (isReceived) {
          receivedCount++;
          presentGarments.push({garmentId: item.garmentId, orderId: item.orderId});
        } else {
          missingCount++;
        }
      }

      const warnings: string[] = [];
      let extraCount = 0;
      for (const tag of [...new Set(body.extraGarmentTagNumbers ?? [])]) {
        const garment = await this.garmentRepo.findOne({
          where: {garmentTagNumber: tag, isDeleted: false} as object,
        });
        if (!garment) {
          warnings.push(`"${tag}" does not match any known garment — skipped.`);
          continue;
        }
        const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
        await this.transferItemRepo.create(
          {
            id: v4(),
            transferId: id,
            garmentId: garment.id,
            garmentTagNumber: garment.garmentTagNumber,
            orderId: orderItem?.orderId ?? '',
            scanStatus: TransferItemScanStatus.EXTRA,
          },
          {transaction: tx},
        );
        extraCount++;
        if (orderItem?.orderId) presentGarments.push({garmentId: garment.id, orderId: orderItem.orderId});
      }

      if (presentGarments.length) {
        const presentOrderIds = [...new Set(presentGarments.map(g => g.orderId))];
        const presentOrders = await this.orderRepo.find({
          where: {id: {inq: presentOrderIds}} as object,
          fields: {id: true, storeId: true} as object,
        });
        const storeIdByOrderId = new Map(presentOrders.map(o => [o.id, o.storeId]));
        for (const {garmentId, orderId} of presentGarments) {
          const isHome = storeIdByOrderId.get(orderId) === transfer.toStoreId;
          await this.garmentRepo.updateById(
            garmentId,
            {activeTransferId: isHome ? (null as unknown as string) : transfer.id},
            {transaction: tx},
          );
        }
      }

      const isClean = missingCount === 0 && extraCount === 0;
      const newStatus = isClean ? TransferStatus.RECEIVED : TransferStatus.DISCREPANCY;
      await this.transferRepo.updateById(
        id,
        {
          status: newStatus,
          receivedAt: now,
          receivedBy: currentUser[securityId],
          remarks: body.remarks ?? transfer.remarks,
          discrepancyCount: missingCount + extraCount,
        },
        {transaction: tx},
      );

      await this.custodyEventRepo.create(
        {
          id: v4(),
          transferId: id,
          eventType: isClean ? TransferCustodyEventType.RECEIVED : TransferCustodyEventType.DISCREPANCY,
          performedBy: currentUser[securityId],
          remarks: isClean ? undefined : `${missingCount} missing, ${extraCount} extra.`,
        },
        {transaction: tx},
      );

      if (isClean) {
        // Release every bag this transfer actually used, not just the
        // primary bagId — a multi-bag transfer locks one Bag row per bag.
        const bagIds = [...new Set(items.map(item => item.bagId ?? transfer.bagId))];
        for (const bagId of bagIds) {
          await this.bagRepo.updateById(
            bagId,
            {
              status: BagStatus.AVAILABLE,
              itemCount: 0,
              currentTransferId: null as unknown as string,
              currentStoreId: transfer.toStoreId,
            },
            {transaction: tx},
          );
          await this.custodyEventRepo.create(
            {
              id: v4(),
              transferId: id,
              eventType: TransferCustodyEventType.BAG_RELEASED,
              bagId,
              performedBy: currentUser[securityId],
            },
            {transaction: tx},
          );
        }
      }

      await tx.commit();
      return {
        message: isClean ? 'Transfer received.' : 'Transfer received with discrepancies.',
        transfer: await this.transferRepo.findById(id),
        reconciliation: {received: receivedCount, missing: missingCount, extra: extraCount},
        warnings,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Resolve a Discrepancy ──────────────────────────────────────────────────
  // Closes out a DISCREPANCY transfer and frees its bag. Any still-missing
  // items that weren't explicitly located stay `missing` on the record —
  // the transfer moves to RESOLVED (not back to RECEIVED) so the fact it
  // was once discrepant is never silently erased. Gated by transfer:update
  // (manager only) rather than transfer:create — writing off missing
  // inventory is an exception/oversight action, not routine counter work.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:update']})
  @post('/transfers/{id}/resolve-discrepancy')
  @response(200, {description: 'Discrepancy resolved, bag released'})
  async resolveDiscrepancy(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['remarks'],
            properties: {
              // Garments previously marked `missing` that have since turned
              // up — flipped to `received` before the transfer is closed.
              // Omit/empty if nothing was found (the missing items are
              // being written off as-is).
              foundGarmentIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {foundGarmentIds?: string[]; remarks: string},
  ): Promise<object> {
    const transfer = await this.transferRepo.findOne({where: {id, isDeleted: false}});
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.status !== TransferStatus.DISCREPANCY) {
      throw new HttpErrors.BadRequest(`Transfer is ${transfer.status}, not discrepancy.`);
    }
    if (!body.remarks?.trim()) {
      throw new HttpErrors.BadRequest('Remarks are required to resolve a discrepancy.');
    }

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, transfer.toStoreId)) {
      throw new HttpErrors.NotFound('Transfer not found.');
    }

    const items = await this.transferItemRepo.find({where: {transferId: id} as object});
    const foundIds = new Set(body.foundGarmentIds ?? []);
    const notMissing = [...foundIds].filter(
      gid => !items.some(i => i.garmentId === gid && i.scanStatus === TransferItemScanStatus.MISSING),
    );
    if (notMissing.length) {
      throw new HttpErrors.BadRequest(
        `Not currently missing on this transfer, cannot mark found: ${notMissing.join(', ')}.`,
      );
    }

    const {v4} = await import('uuid');
    const now = new Date();
    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      let foundCount = 0;
      const foundGarments: {garmentId: string; orderId: string}[] = [];
      for (const item of items) {
        if (item.scanStatus === TransferItemScanStatus.MISSING && foundIds.has(item.garmentId)) {
          await this.transferItemRepo.updateById(
            item.id,
            {scanStatus: TransferItemScanStatus.RECEIVED},
            {transaction: tx},
          );
          foundCount++;
          foundGarments.push({garmentId: item.garmentId, orderId: item.orderId});
        }
      }

      // Same dual-access grant/clear as receive() — a garment located
      // late still needs the same access grant it would have gotten if
      // it had been received cleanly the first time.
      if (foundGarments.length) {
        const foundOrderIds = [...new Set(foundGarments.map(g => g.orderId))];
        const foundOrders = await this.orderRepo.find({
          where: {id: {inq: foundOrderIds}} as object,
          fields: {id: true, storeId: true} as object,
        });
        const storeIdByOrderId = new Map(foundOrders.map(o => [o.id, o.storeId]));
        for (const {garmentId, orderId} of foundGarments) {
          const isHome = storeIdByOrderId.get(orderId) === transfer.toStoreId;
          await this.garmentRepo.updateById(
            garmentId,
            {activeTransferId: isHome ? (null as unknown as string) : transfer.id},
            {transaction: tx},
          );
        }
      }

      const remainingDiscrepant = items.filter(
        i =>
          (i.scanStatus === TransferItemScanStatus.MISSING && !foundIds.has(i.garmentId)) ||
          i.scanStatus === TransferItemScanStatus.EXTRA,
      ).length;

      await this.transferRepo.updateById(
        id,
        {
          status: TransferStatus.RESOLVED,
          resolvedAt: now,
          resolvedBy: currentUser[securityId],
          remarks: body.remarks,
          discrepancyCount: remainingDiscrepant,
        },
        {transaction: tx},
      );

      await this.custodyEventRepo.create(
        {
          id: v4(),
          transferId: id,
          eventType: TransferCustodyEventType.DISCREPANCY_RESOLVED,
          performedBy: currentUser[securityId],
          remarks: body.remarks,
        },
        {transaction: tx},
      );

      // Release every bag this transfer actually used, not just the
      // primary bagId — a multi-bag transfer locks one Bag row per bag.
      const bagIds = [...new Set(items.map(item => item.bagId ?? transfer.bagId))];
      for (const bagId of bagIds) {
        await this.bagRepo.updateById(
          bagId,
          {
            status: BagStatus.AVAILABLE,
            itemCount: 0,
            currentTransferId: null as unknown as string,
            currentStoreId: transfer.toStoreId,
          },
          {transaction: tx},
        );
        await this.custodyEventRepo.create(
          {
            id: v4(),
            transferId: id,
            eventType: TransferCustodyEventType.BAG_RELEASED,
            bagId,
            performedBy: currentUser[securityId],
          },
          {transaction: tx},
        );
      }

      await tx.commit();
      return {
        message: 'Discrepancy resolved. Bag released.',
        transfer: await this.transferRepo.findById(id),
        itemsFound: foundCount,
        remainingDiscrepancies: remainingDiscrepant,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Item Tracking ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/transfers/item/{garmentTag}')
  @response(200, {description: 'Current transfer/bag/store location for one garment tag'})
  async trackItem(@param.path.string('garmentTag') garmentTag: string): Promise<object> {
    const item = await this.transferItemRepo.findOne({
      where: {garmentTagNumber: garmentTag} as object,
      order: ['createdAt DESC'],
    });
    if (!item) return {tracked: false};

    const transfer = await this.transferRepo.findById(item.transferId);
    // This item's own bag — on a multi-bag transfer that isn't necessarily
    // transfer.bagId (the primary/first bag), which only holds for
    // pre-multi-bag rows with no bagId of their own.
    const [bag, fromStore, toStore, order] = await Promise.all([
      this.bagRepo.findOne({where: {id: item.bagId ?? transfer.bagId}}),
      this.storeRepo.findOne({where: {id: transfer.fromStoreId}}),
      this.storeRepo.findOne({where: {id: transfer.toStoreId}}),
      this.orderRepo.findOne({where: {id: item.orderId}}),
    ]);

    return {
      tracked: true,
      garmentTagNumber: garmentTag,
      currentStage: item.scanStatus,
      currentTransfer: transfer,
      currentLocationLabel: this.buildLocationLabel(transfer, fromStore?.name ?? null, toStore?.name ?? null),
      bag,
      fromStore,
      toStore,
      orderId: item.orderId,
      orderNumber: order?.orderNumber ?? null,
    };
  }

  // ─── Custody / Trail Report ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/transfer-custody-events')
  @response(200, {description: 'Custody/trail log, filterable by tag/transfer/store/date'})
  async listCustodyEvents(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('garmentTag') garmentTag?: string,
    @param.query.string('transferId') transferId?: string,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    let transferIds: string[] | null = transferId ? [transferId] : null;

    // Tag search must pull in transfer-level events (sent_out/received/
    // bag_released) for that tag's transfer too, not just item-level ones —
    // otherwise the trail view would miss the events that matter most.
    if (garmentTag) {
      const items = await this.transferItemRepo.find({
        where: {garmentTagNumber: garmentTag} as object,
      });
      const tagTransferIds = [...new Set(items.map(i => i.transferId))];
      transferIds = transferIds ? transferIds.filter(id => tagTransferIds.includes(id)) : tagTransferIds;
    }

    if (storeId ?? dateFrom ?? dateTo) {
      const and: object[] = [];
      if (storeId) and.push({or: [{fromStoreId: storeId}, {toStoreId: storeId}]});
      if (dateFrom ?? dateTo) {
        and.push({
          createdAt: {
            ...(dateFrom ? {gte: new Date(dateFrom)} : {}),
            ...(dateTo ? {lte: new Date(dateTo)} : {}),
          },
        });
      }
      const matching = await this.transferRepo.find({
        where: {and} as object,
        fields: {id: true} as object,
      });
      const matchingIds = matching.map(t => t.id);
      transferIds = transferIds ? transferIds.filter(id => matchingIds.includes(id)) : matchingIds;
    }

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!scope.global) {
      const scoped = await this.transferRepo.find({
        where: {
          or: [{fromStoreId: {inq: scope.storeIds}}, {toStoreId: {inq: scope.storeIds}}],
        } as object,
        fields: {id: true} as object,
      });
      const scopedIds = scoped.map(t => t.id);
      transferIds = transferIds ? transferIds.filter(id => scopedIds.includes(id)) : scopedIds;
    }

    if (transferIds !== null && !transferIds.length) return {events: []};

    const events = await this.custodyEventRepo.find({
      where: (transferIds ? {transferId: {inq: transferIds}} : {}) as object,
      order: ['performedAt DESC'],
    });
    if (!events.length) return {events: []};

    // Raw events only carry transferId/performedBy uuids — resolve both to
    // display values (transitId, performer name) the same way
    // enrichTransfers() already does for list/detail, rather than making
    // the admin panel show raw ids.
    const [transfers, users, bags] = await Promise.all([
      this.transferRepo.find({
        where: {id: {inq: [...new Set(events.map(e => e.transferId))]}} as object,
        fields: {id: true, transitId: true} as object,
      }),
      this.usersRepo.find({
        where: {id: {inq: [...new Set(events.map(e => e.performedBy).filter(Boolean))]}} as object,
        fields: {id: true, fullName: true} as object,
      }),
      this.bagRepo.find({
        where: {id: {inq: [...new Set(events.map(e => e.bagId).filter(Boolean))]}} as object,
        fields: {id: true, bagNumber: true} as object,
      }),
    ]);
    const transitIdByTransferId = new Map(transfers.map(t => [t.id, t.transitId]));
    const nameByUserId = new Map(users.map(u => [u.id, u.fullName]));
    const bagNumberByBagId = new Map(bags.map(b => [b.id, b.bagNumber]));

    return {
      events: events.map(e => ({
        ...e,
        transitId: transitIdByTransferId.get(e.transferId) ?? null,
        performedByName: nameByUserId.get(e.performedBy) ?? null,
        bagNumber: e.bagId ? bagNumberByBagId.get(e.bagId) ?? null : null,
      })),
    };
  }
}
