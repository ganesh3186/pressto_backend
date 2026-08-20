import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {
  del,
  get,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {GarmentImageType} from '../models/garment-image-type.enum';
import {
  GarmentStatus,
  GARMENT_STATUS_RANK,
  GARMENT_STATUS_TRANSITIONS,
} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {UnprocessedHandlingMode} from '../models/unprocessed-handling-mode.enum';
import {
  BrandRepository,
  ColorRepository,
  GarmentDamageImageRepository,
  GarmentDamageRepository,
  GarmentImageRepository,
  GarmentRepository,
  GarmentStainImageRepository,
  GarmentStainRepository,
  GarmentStatusHistoryRepository,
  ItemRepository,
  MediaRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  ServiceRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

// Shape returned when a garment's order item can't be resolved — keeps the
// response keys stable so clients never have to guard for missing fields.
const EMPTY_ITEM_CONTEXT = {
  orderId: null,
  itemId: null,
  itemName: null,
  serviceId: null,
  serviceName: null,
};

export class GarmentController {
  constructor(
    @repository(OrderRepository) private orderRepository: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepository: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepository: GarmentRepository,
    @repository(GarmentDamageRepository) private damageRepository: GarmentDamageRepository,
    @repository(GarmentDamageImageRepository) private damageImageRepository: GarmentDamageImageRepository,
    @repository(GarmentStainRepository) private stainRepository: GarmentStainRepository,
    @repository(GarmentStainImageRepository) private stainImageRepository: GarmentStainImageRepository,
    @repository(GarmentImageRepository) private imageRepository: GarmentImageRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepository: GarmentStatusHistoryRepository,
    @repository(OrderStatusHistoryRepository) private orderStatusHistoryRepository: OrderStatusHistoryRepository,
    @repository(ItemRepository) private itemRepository: ItemRepository,
    @repository(MediaRepository) private mediaRepository: MediaRepository,
    @repository(ServiceRepository) private serviceRepository: ServiceRepository,
    @repository(BrandRepository) private brandRepository: BrandRepository,
    @repository(ColorRepository) private colorRepository: ColorRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Store Scoping ────────────────────────────────────────────────────────
  // Garments carry no storeId of their own: they reach a store through
  // orderItem -> order -> storeId. Resolving that forward (every order in scope,
  // then every item of those orders) would build an unbounded `inq`, so reads
  // instead post-filter the already-bounded result page.

  /** Drop garments whose parent order falls outside the caller's store scope. */
  private async _filterByStoreScope<T extends {orderItemId: string}>(
    garments: T[],
    currentUser: UserProfile,
  ): Promise<T[]> {
    const scope = await this.storeScopeService.resolve(currentUser);
    if (scope.global || !garments.length) return garments;

    const orderItemIds = [...new Set(garments.map(g => g.orderItemId).filter(Boolean))];
    if (!orderItemIds.length) return [];

    const orderItems = await this.orderItemRepository.find({
      where: {id: {inq: orderItemIds}} as any,
      fields: {id: true, orderId: true} as any,
    });
    const orderIds = [...new Set(orderItems.map(oi => oi.orderId).filter(Boolean))];
    if (!orderIds.length) return [];

    const orders = await this.orderRepository.find({
      where: {id: {inq: orderIds}, isDeleted: false} as any,
      fields: {id: true, storeId: true} as any,
    });

    const allowedOrderIds = new Set(
      orders.filter(o => this.storeScopeService.allows(scope, o.storeId)).map(o => String(o.id)),
    );
    // Also allow orders reachable via an active inter-store transfer grant
    // to this scope — additive, doesn't narrow anything the direct
    // storeId check already allowed.
    for (const id of await this.storeScopeService.transferGrantedOrderIds(scope.storeIds)) {
      allowedOrderIds.add(String(id));
    }
    const orderIdByItemId = new Map(orderItems.map(oi => [String(oi.id), String(oi.orderId)]));

    return garments.filter(g => {
      const orderId = orderIdByItemId.get(String(g.orderItemId));
      return Boolean(orderId && allowedOrderIds.has(orderId));
    });
  }

  // ─── Register Garments for an Order Item ──────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/orders/{orderId}/items/{orderItemId}/garments')
  @response(200, {description: 'Garment registered for order item'})
  async registerGarment(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @param.path.string('orderItemId') orderItemId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              brandId: {type: 'string', format: 'uuid'},
              colorId: {type: 'string', format: 'uuid'},
              qrCode: {type: 'string'},
              customerRemarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {brandId?: string; colorId?: string; qrCode?: string; customerRemarks?: string},
  ): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const orderItem = await this.orderItemRepository.findOne({where: {id: orderItemId, orderId}});
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    const existingCount = await this.garmentRepository.count({orderItemId, isDeleted: false});
    if (existingCount.count >= orderItem.quantity) {
      throw new HttpErrors.BadRequest(
        `All ${orderItem.quantity} garments for this order item have already been registered.`,
      );
    }

    const totalCount = await this.garmentRepository.count();
    const garmentTagNumber = `GT${String(totalCount.count + 1).padStart(8, '0')}`;

    const garment = await this.garmentRepository.create({
      orderItemId,
      garmentTagNumber,
      brandId: body.brandId,
      colorId: body.colorId,
      qrCode: body.qrCode,
      customerRemarks: body.customerRemarks,
      status: GarmentStatus.RECEIVED,
    });

    const {v4} = await import('uuid');
    await this.garmentStatusHistoryRepository.create({
      id: v4(),
      garmentId: garment.id,
      status: GarmentStatus.RECEIVED,
      changedAt: new Date(),
      changedBy: currentUser[securityId],
      remarks: 'Garment received at store',
    });

    return {message: 'Garment registered.', garment};
  }

  // ─── List Garments for an Order ───────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/orders/{orderId}/garments')
  @response(200, {description: 'Garments for an order'})
  async listGarments(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);
    const items = await this.orderItemRepository.find({where: {orderId}});
    const orderItemIds = items.map(i => i.id);

    const garments = await this.garmentRepository.find({
      where: {and: [{orderItemId: {inq: orderItemIds}}, {isDeleted: false}]},
    });

    const withContext = await this._withItemContext(garments);

    const garmentDetails = await Promise.all(
      withContext.map(async g => {
        const [damages, stains, rawImages] = await Promise.all([
          this._damagesWithImages(g.id),
          this._stainsWithImages(g.id),
          this.imageRepository.find({where: {garmentId: g.id}}),
        ]);
        const images = await this._attachMediaUrls(rawImages);
        return {...g, damages, stains, images};
      }),
    );

    return {garments: garmentDetails};
  }

  // ─── Scan Lookup (by tag number or UUID) ─────────────────────────────────
  // Must be declared before /garments/{garmentId} so the static path wins.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/garments/lookup')
  @response(200, {description: 'Full garment details by tag number or UUID — used by scan/QR lookup'})
  async lookupGarment(
    @param.query.string('q') q: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    if (!q?.trim()) throw new HttpErrors.BadRequest('Query param "q" is required.');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(q.trim());

    const garment = isUuid
      ? await this.garmentRepository.findOne({where: {id: q.trim(), isDeleted: false}})
      : await this.garmentRepository.findOne({where: {garmentTagNumber: q.trim(), isDeleted: false}});

    if (!garment) throw new HttpErrors.NotFound(`Garment "${q}" not found.`);

    // Scanning a tag from another store must look identical to an unknown tag,
    // otherwise the lookup confirms which tags exist elsewhere.
    const [inScope] = await this._filterByStoreScope([garment], currentUser!);
    if (!inScope) throw new HttpErrors.NotFound(`Garment "${q}" not found.`);

    const orderItem = await this.orderItemRepository.findOne({where: {id: garment.orderItemId}});
    const orderId = orderItem?.orderId ?? null;

    const [item, service, order, brand, color] = await Promise.all([
      orderItem?.itemId ? this.itemRepository.findOne({where: {id: orderItem.itemId}}) : Promise.resolve(null),
      orderItem?.serviceId ? this.serviceRepository.findOne({where: {id: orderItem.serviceId}}) : Promise.resolve(null),
      orderId ? this.orderRepository.findOne({where: {id: orderId}}) : Promise.resolve(null),
      garment.brandId ? this.brandRepository.findOne({where: {id: garment.brandId}}) : Promise.resolve(null),
      garment.colorId ? this.colorRepository.findOne({where: {id: garment.colorId}}) : Promise.resolve(null),
    ]);

    const [damages, stains, images, statusHistory] = await Promise.all([
      this._damagesWithImages(garment.id),
      this._stainsWithImages(garment.id),
      this.imageRepository.find({where: {garmentId: garment.id}}),
      this.garmentStatusHistoryRepository.find({where: {garmentId: garment.id}, order: ['changedAt DESC']}),
    ]);

    return {
      ...garment,
      orderId,
      orderNumber: (order as any)?.orderNumber ?? null,
      orderItemId: garment.orderItemId,
      itemName: item?.name ?? null,
      serviceName: service?.name ?? null,
      brandName: (brand as any)?.name ?? null,
      colorName: (color as any)?.name ?? null,
      damages,
      stains,
      images,
      statusHistory,
    };
  }

  // ─── Get Single Garment ───────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/garments/{garmentId}')
  @response(200, {description: 'Garment details'})
  async getGarment(
    @param.path.string('garmentId') garmentId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    // Same 404 as a missing garment: an out-of-scope garment must not be distinguishable.
    const [inScope] = await this._filterByStoreScope([garment], currentUser!);
    if (!inScope) throw new HttpErrors.NotFound('Garment not found.');

    const [withContext] = await this._withItemContext([garment]);

    const [damages, stains, rawImages, statusHistory, brand, color] = await Promise.all([
      this._damagesWithImages(garmentId),
      this._stainsWithImages(garmentId),
      this.imageRepository.find({where: {garmentId}}),
      this.garmentStatusHistoryRepository.find({where: {garmentId}, order: ['changedAt DESC']}),
      garment.brandId ? this.brandRepository.findOne({where: {id: garment.brandId}}) : Promise.resolve(null),
      garment.colorId ? this.colorRepository.findOne({where: {id: garment.colorId}}) : Promise.resolve(null),
    ]);

    const images = await this._attachMediaUrls(rawImages);

    return {
      ...withContext,
      brandName: (brand as any)?.name ?? null,
      colorName: (color as any)?.name ?? null,
      damages,
      stains,
      images,
      statusHistory,
    };
  }

  // ─── Search Garments by Filter ───────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/garments')
  @response(200, {description: 'Search garments by filter'})
  async searchGarments(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('filter') filterStr?: string,
    @param.query.string('orderId') orderId?: string,
    @param.query.number('limit') limit?: number,
  ): Promise<object[]> {
    let where: Record<string, unknown> = {isDeleted: false};

    if (filterStr) {
      try {
        const parsed = JSON.parse(filterStr);
        if (parsed?.where && typeof parsed.where === 'object') {
          where = {...parsed.where, isDeleted: false};
        }
      } catch {
        // ignore malformed filter
      }
    }

    // orderId lives on the order item, not the garment, so it can't come through
    // the LoopBack `filter` — resolve it to the garment's own orderItemId column.
    if (orderId) {
      const items = await this.orderItemRepository.find({where: {orderId}});
      if (!items.length) return [];
      where = {...where, orderItemId: {inq: items.map(i => i.id)}};
    }

    const garments = await this.garmentRepository.find({
      where,
      limit: Math.min(Number(limit ?? 20), 200),
    });

    // The client controls `where` here, so the page is filtered to the caller's
    // stores before anything is returned.
    const inScope = await this._filterByStoreScope(garments, currentUser);
    return this._withItemContext(inScope);
  }

  // ─── Update Garment ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:update']})
  @patch('/garments/{garmentId}')
  @response(200, {description: 'Garment updated'})
  async updateGarment(
    @param.path.string('garmentId') garmentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              brandId: {type: 'string', format: 'uuid'},
              colorId: {type: 'string', format: 'uuid'},
              qrCode: {type: 'string'},
              customerRemarks: {type: 'string'},
              inspectionRemarks: {type: 'string'},
              qrPrintCount: {type: 'number'},
              isTagPrinted: {type: 'boolean'},
              unprocessedHandlingMode: {type: 'string', enum: Object.values(UnprocessedHandlingMode)},
            },
          },
        },
      },
    })
    body: {
      brandId?: string;
      colorId?: string;
      qrCode?: string;
      customerRemarks?: string;
      inspectionRemarks?: string;
      qrPrintCount?: number;
      isTagPrinted?: boolean;
      unprocessedHandlingMode?: UnprocessedHandlingMode;
    },
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);
    await this.garmentRepository.updateById(garmentId, body);
    return {message: 'Garment updated.'};
  }

  // ─── Change Garment Status ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/status')
  @response(200, {description: 'Garment status updated'})
  async changeGarmentStatus(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('garmentId') garmentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: {
              status: {type: 'string', enum: Object.values(GarmentStatus)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {status: GarmentStatus; remarks?: string},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    // Block direct on_hold — must come through the approval flow
    if (body.status === GarmentStatus.ON_HOLD) {
      throw new HttpErrors.BadRequest(
        "Garment cannot be put on hold directly. Submit a return_item or item_damaged approval request.",
      );
    }

    // Validate state machine transition
    const allowed = GARMENT_STATUS_TRANSITIONS[garment.status as GarmentStatus] ?? [];
    if (!allowed.includes(body.status)) {
      throw new HttpErrors.BadRequest(
        `Invalid transition: '${garment.status}' → '${body.status}'. Allowed: [${allowed.join(', ') || 'none'}].`,
      );
    }

    const {v4} = await import('uuid');
    await this.garmentRepository.updateById(garmentId, {status: body.status});
    await this.garmentStatusHistoryRepository.create({
      id: v4(),
      garmentId,
      status: body.status,
      changedAt: new Date(),
      changedBy: currentUser[securityId],
      remarks: body.remarks,
    });

    await this.syncOrderStatus(garmentId, body.status, currentUser[securityId]);

    return {message: `Garment status changed to '${body.status}'.`};
  }

  // ─── Stains ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/stains')
  @response(200, {description: 'Stain recorded'})
  async addStain(
    @param.path.string('garmentId') garmentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['stainId'],
            properties: {
              stainId: {type: 'string', format: 'uuid'},
              remarks: {type: 'string'},
              mediaIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Already-uploaded media IDs for stain photos',
              },
            },
          },
        },
      },
    })
    body: {stainId: string; remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);

    const {v4} = await import('uuid');
    const stain = await this.stainRepository.create({
      id: v4(),
      garmentId,
      stainId: body.stainId,
      remarks: body.remarks,
    });

    const images = [];
    for (const mediaId of body.mediaIds ?? []) {
      const img = await this.stainImageRepository.create({
        id: v4(),
        garmentStainId: stain.id,
        mediaId,
      });
      images.push(img);
    }

    return {message: 'Stain recorded.', stain: {...stain, images}};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/stains/{stainId}/images')
  @response(200, {description: 'Image added to stain'})
  async addStainImage(
    @param.path.string('garmentId') garmentId: string,
    @param.path.string('stainId') stainId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['mediaId'],
            properties: {mediaId: {type: 'string', format: 'uuid'}},
          },
        },
      },
    })
    body: {mediaId: string},
  ): Promise<object> {
    const stain = await this.stainRepository.findOne({where: {id: stainId, garmentId, isDeleted: false}});
    if (!stain) throw new HttpErrors.NotFound('Stain not found.');
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);

    const {v4} = await import('uuid');
    const image = await this.stainImageRepository.create({id: v4(), garmentStainId: stainId, mediaId: body.mediaId});
    return {message: 'Image added.', image};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:delete']})
  @del('/garments/{garmentId}/stains/{stainId}')
  @response(200, {description: 'Stain removed'})
  async removeStain(
    @param.path.string('garmentId') garmentId: string,
    @param.path.string('stainId') stainId: string,
  ): Promise<object> {
    const stain = await this.stainRepository.findById(stainId);
    if (stain.garmentId !== garmentId) throw new HttpErrors.Forbidden('Stain does not belong to this garment.');
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);
    await this.stainRepository.updateById(stainId, {isDeleted: true});
    return {message: 'Stain removed.'};
  }

  // ─── Damages ──────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/damages')
  @response(200, {description: 'Damage recorded'})
  async addDamage(
    @param.path.string('garmentId') garmentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['damageTypeId'],
            properties: {
              damageTypeId: {type: 'string', format: 'uuid'},
              remarks: {type: 'string'},
              mediaIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Already-uploaded media IDs for damage photos',
              },
            },
          },
        },
      },
    })
    body: {damageTypeId: string; remarks?: string; mediaIds?: string[]},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);

    const {v4} = await import('uuid');
    const damage = await this.damageRepository.create({
      id: v4(),
      garmentId,
      damageTypeId: body.damageTypeId,
      remarks: body.remarks,
    });

    const images = [];
    for (const mediaId of body.mediaIds ?? []) {
      const img = await this.damageImageRepository.create({
        id: v4(),
        garmentDamageId: damage.id,
        mediaId,
      });
      images.push(img);
    }

    return {message: 'Damage recorded.', damage: {...damage, images}};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/damages/{damageId}/images')
  @response(200, {description: 'Image added to damage'})
  async addDamageImage(
    @param.path.string('garmentId') garmentId: string,
    @param.path.string('damageId') damageId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['mediaId'],
            properties: {mediaId: {type: 'string', format: 'uuid'}},
          },
        },
      },
    })
    body: {mediaId: string},
  ): Promise<object> {
    const damage = await this.damageRepository.findOne({where: {id: damageId, garmentId, isDeleted: false}});
    if (!damage) throw new HttpErrors.NotFound('Damage not found.');
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);

    const {v4} = await import('uuid');
    const image = await this.damageImageRepository.create({id: v4(), garmentDamageId: damageId, mediaId: body.mediaId});
    return {message: 'Image added.', image};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:delete']})
  @del('/garments/{garmentId}/damages/{damageId}')
  @response(200, {description: 'Damage removed'})
  async removeDamage(
    @param.path.string('garmentId') garmentId: string,
    @param.path.string('damageId') damageId: string,
  ): Promise<object> {
    const damage = await this.damageRepository.findById(damageId);
    if (damage.garmentId !== garmentId) throw new HttpErrors.Forbidden('Damage does not belong to this garment.');
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);
    await this.damageRepository.updateById(damageId, {isDeleted: true});
    return {message: 'Damage removed.'};
  }

  // ─── Garment Images ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:create']})
  @post('/garments/{garmentId}/images')
  @response(200, {description: 'Image attached to garment'})
  async addImage(
    @param.path.string('garmentId') garmentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['mediaId', 'imageType'],
            properties: {
              mediaId: {type: 'string', format: 'uuid'},
              imageType: {type: 'string', enum: Object.values(GarmentImageType)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {mediaId: string; imageType: GarmentImageType; remarks?: string},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);
    const image = await this.imageRepository.create({garmentId, ...body});
    return {message: 'Image attached.', image};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:delete']})
  @del('/garments/{garmentId}/images/{imageId}')
  @response(200, {description: 'Image removed'})
  async removeImage(
    @param.path.string('garmentId') garmentId: string,
    @param.path.string('imageId') imageId: string,
  ): Promise<object> {
    const image = await this.imageRepository.findById(imageId);
    if (image.garmentId !== garmentId) throw new HttpErrors.Forbidden('Image does not belong to this garment.');
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    this.assertInspectionEditable(garment);
    await this.imageRepository.deleteById(imageId);
    return {message: 'Image removed.'};
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Inspection data (brand/color/stains/damages/photos) stays editable
   * through quality_check — the last checkpoint before a garment is ready
   * for dispatch. Locked once it moves past that, and once returned to the
   * customer regardless of rank (on_hold, rank -1, stays editable — it's a
   * pause mid-pipeline, not a completed stage).
   */
  private assertInspectionEditable(garment: {status?: string}): void {
    const status = garment.status as GarmentStatus;
    const pastQualityCheck =
      GARMENT_STATUS_RANK[status] > GARMENT_STATUS_RANK[GarmentStatus.QUALITY_CHECK];
    if (status === GarmentStatus.RETURNED_TO_CUSTOMER || pastQualityCheck) {
      throw new HttpErrors.BadRequest(
        `Inspection data cannot be edited once a garment is '${status}'.`,
      );
    }
  }

  // ─── Order status auto-sync ───────────────────────────────────────────────

  private async syncOrderStatus(garmentId: string, newStatus: GarmentStatus, changedBy: string): Promise<void> {
    const garment = await this.garmentRepository.findById(garmentId);
    const orderItem = await this.orderItemRepository.findById(garment.orderItemId);
    const order = await this.orderRepository.findOne({where: {id: orderItem.orderId, isDeleted: false}});
    if (!order) return;

    // Terminal orders don't get auto-synced
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED) return;

    const allItems = await this.orderItemRepository.find({where: {orderId: order.id}});
    const allItemIds = allItems.map(i => i.id);
    const allGarments = await this.garmentRepository.find({
      where: {orderItemId: {inq: allItemIds}, isDeleted: false} as any,
    });

    // Compute effective status for each garment (apply the incoming change optimistically)
    const effectiveStatuses = allGarments.map(g =>
      g.id === garmentId ? newStatus : (g.status as GarmentStatus),
    );

    // Active garments = those still in the pipeline (on_hold and returned garments are excluded)
    const activeStatuses = effectiveStatuses.filter(
      s => s !== GarmentStatus.ON_HOLD && s !== GarmentStatus.RETURNED_TO_CUSTOMER,
    );

    const {v4} = await import('uuid');
    const now = new Date();

    const setOrderStatus = async (status: OrderStatus, remarks: string) => {
      if (order.status === status) return;
      await this.orderRepository.updateById(order.id, {status});
      await this.orderStatusHistoryRepository.create({
        id: v4(), orderId: order.id, status, changedAt: now, changedBy, remarks,
      });
    };

    // All garments on hold = full return → cancel order
    if (activeStatuses.length === 0) {
      await setOrderStatus(OrderStatus.CANCELLED, 'Auto-cancelled: all garments returned/on hold');
      return;
    }

    // Rank every status so we can find the bottleneck (minimum rank among active garments)
    const STATUS_RANK = GARMENT_STATUS_RANK;

    const RANK_TO_ORDER_STATUS: Record<number, OrderStatus> = {
      0: OrderStatus.RECEIVED_AT_STORE,
      1: OrderStatus.IN_INSPECTION,
      2: OrderStatus.IN_PROCESS,
      3: OrderStatus.QUALITY_CHECK,
      4: OrderStatus.READY,
      5: OrderStatus.OUT_FOR_DELIVERY,
      6: OrderStatus.DELIVERED,
    };

    const minRank = Math.min(...activeStatuses.map(s => STATUS_RANK[s] ?? 0));
    const derived = RANK_TO_ORDER_STATUS[minRank];
    if (derived) {
      await setOrderStatus(derived, `Auto-synced: garment pipeline bottleneck is '${activeStatuses.find(s => STATUS_RANK[s] === minRank)}'`);
    }
  }

  // Garments only carry an orderItemId — the item and service a customer actually
  // recognises live one hop away on the order item. Resolve them in bulk (three
  // queries total, regardless of how many garments) rather than per garment.
  private async _withItemContext<T extends {orderItemId: string}>(garments: T[]) {
    const orderItemIds = [...new Set(garments.map(g => g.orderItemId).filter(Boolean))];
    if (!orderItemIds.length) return garments.map(g => ({...g, ...EMPTY_ITEM_CONTEXT}));

    const orderItems = await this.orderItemRepository.find({
      where: {id: {inq: orderItemIds}} as any,
    });

    const itemIds = [...new Set(orderItems.map(oi => oi.itemId).filter(Boolean))];
    const serviceIds = [...new Set(orderItems.map(oi => oi.serviceId).filter(Boolean))];

    const [items, services] = await Promise.all([
      itemIds.length ? this.itemRepository.find({where: {id: {inq: itemIds}} as any}) : Promise.resolve([]),
      serviceIds.length
        ? this.serviceRepository.find({where: {id: {inq: serviceIds}} as any})
        : Promise.resolve([]),
    ]);

    const orderItemMap = new Map(orderItems.map(oi => [oi.id, oi]));
    const itemMap = new Map(items.map(i => [i.id, i]));
    const serviceMap = new Map(services.map(s => [s.id, s]));

    return garments.map(g => {
      const orderItem = orderItemMap.get(g.orderItemId);
      if (!orderItem) return {...g, ...EMPTY_ITEM_CONTEXT};

      const item = itemMap.get(orderItem.itemId);
      const service = serviceMap.get(orderItem.serviceId);

      return {
        ...g,
        orderId: orderItem.orderId ?? null,
        itemId: orderItem.itemId ?? null,
        itemName: (item as any)?.name ?? null,
        serviceId: orderItem.serviceId ?? null,
        serviceName: (service as any)?.name ?? null,
      };
    });
  }

  private async _stainsWithImages(garmentId: string) {
    const stains = await this.stainRepository.find({where: {garmentId, isDeleted: false}});
    return Promise.all(
      stains.map(async s => {
        const images = await this.stainImageRepository.find({where: {garmentStainId: s.id}});
        return {...s, images: await this._attachMediaUrls(images)};
      }),
    );
  }

  private async _damagesWithImages(garmentId: string) {
    const damages = await this.damageRepository.find({where: {garmentId, isDeleted: false}});
    return Promise.all(
      damages.map(async d => {
        const images = await this.damageImageRepository.find({where: {garmentDamageId: d.id}});
        return {...d, images: await this._attachMediaUrls(images)};
      }),
    );
  }

  // Resolve each image record's mediaId → the media's fileUrl so the frontend
  // has a viewable URL (image records only store mediaId). Exposes fileUrl / url
  // plus a nested media object to cover the fields the UI checks.
  private async _attachMediaUrls<T extends {mediaId?: string}>(images: T[]) {
    return Promise.all(
      images.map(async img => {
        let media = null;
        if (img.mediaId) {
          media = await this.mediaRepository.findOne({where: {id: img.mediaId} as any});
        }
        const fileUrl = (media as any)?.fileUrl ?? null;
        return {...img, media, fileUrl, url: fileUrl};
      }),
    );
  }
}
