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
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {UnprocessedHandlingMode} from '../models/unprocessed-handling-mode.enum';
import {
  GarmentDamageImageRepository,
  GarmentDamageRepository,
  GarmentImageRepository,
  GarmentRepository,
  GarmentStainImageRepository,
  GarmentStainRepository,
  GarmentStatusHistoryRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  ServiceRepository,
} from '../repositories';

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
    @repository(ServiceRepository) private serviceRepository: ServiceRepository,
  ) {}

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
  async listGarments(@param.path.string('orderId') orderId: string): Promise<object> {
    const items = await this.orderItemRepository.find({where: {orderId}});
    const orderItemIds = items.map(i => i.id);

    const garments = await this.garmentRepository.find({
      where: {and: [{orderItemId: {inq: orderItemIds}}, {isDeleted: false}]},
    });

    const garmentDetails = await Promise.all(
      garments.map(async g => {
        const [damages, stains, images] = await Promise.all([
          this._damagesWithImages(g.id),
          this._stainsWithImages(g.id),
          this.imageRepository.find({where: {garmentId: g.id}}),
        ]);
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
  ): Promise<object> {
    if (!q?.trim()) throw new HttpErrors.BadRequest('Query param "q" is required.');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(q.trim());

    const garment = isUuid
      ? await this.garmentRepository.findOne({where: {id: q.trim(), isDeleted: false}})
      : await this.garmentRepository.findOne({where: {garmentTagNumber: q.trim(), isDeleted: false}});

    if (!garment) throw new HttpErrors.NotFound(`Garment "${q}" not found.`);

    const orderItem = await this.orderItemRepository.findOne({where: {id: garment.orderItemId}});
    const orderId = orderItem?.orderId ?? null;

    const [item, service] = await Promise.all([
      orderItem?.itemId ? this.itemRepository.findOne({where: {id: orderItem.itemId}}) : Promise.resolve(null),
      orderItem?.serviceId ? this.serviceRepository.findOne({where: {id: orderItem.serviceId}}) : Promise.resolve(null),
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
      orderItemId: garment.orderItemId,
      itemName: item?.name ?? null,
      serviceName: service?.name ?? null,
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
  async getGarment(@param.path.string('garmentId') garmentId: string): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const [damages, stains, images, statusHistory] = await Promise.all([
      this._damagesWithImages(garmentId),
      this._stainsWithImages(garmentId),
      this.imageRepository.find({where: {garmentId}}),
      this.garmentStatusHistoryRepository.find({where: {garmentId}, order: ['changedAt DESC']}),
    ]);

    return {...garment, damages, stains, images, statusHistory};
  }

  // ─── Search Garments by Filter ───────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['garment:read']})
  @get('/garments')
  @response(200, {description: 'Search garments by filter'})
  async searchGarments(
    @param.query.string('filter') filterStr?: string,
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

    const garments = await this.garmentRepository.find({where, limit: 20});

    // Resolve orderId via orderItem so callers can navigate to the parent order
    const enriched = await Promise.all(
      garments.map(async (g) => {
        const orderItem = await this.orderItemRepository.findOne({where: {id: g.orderItemId}});
        return {...g, orderId: orderItem?.orderId ?? null};
      }),
    );

    return enriched;
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
    await this.imageRepository.deleteById(imageId);
    return {message: 'Image removed.'};
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  // ─── Order status auto-sync ───────────────────────────────────────────────

  private async syncOrderStatus(garmentId: string, newStatus: GarmentStatus, changedBy: string): Promise<void> {
    const garment = await this.garmentRepository.findById(garmentId);
    const orderItem = await this.orderItemRepository.findById(garment.orderItemId);
    const order = await this.orderRepository.findOne({where: {id: orderItem.orderId, isDeleted: false}});
    if (!order) return;

    const allItems = await this.orderItemRepository.find({where: {orderId: order.id}});
    const allItemIds = allItems.map(i => i.id);
    const allGarments = await this.garmentRepository.find({
      where: {orderItemId: {inq: allItemIds}, isDeleted: false} as any,
    });

    const {v4} = await import('uuid');
    const now = new Date();

    // Trigger 1: first garment reaches IN_INSPECTION → order moves to in_inspection
    if (newStatus === GarmentStatus.IN_INSPECTION && order.status === OrderStatus.RECEIVED_AT_STORE) {
      await this.orderRepository.updateById(order.id, {status: OrderStatus.IN_INSPECTION});
      await this.orderStatusHistoryRepository.create({
        id: v4(),
        orderId: order.id,
        status: OrderStatus.IN_INSPECTION,
        changedAt: now,
        changedBy,
        remarks: 'Auto-advanced: first garment moved to inspection',
      });
      return;
    }

    // Trigger 2: all garments past inspection → order moves to in_process
    const PAST_INSPECTION: GarmentStatus[] = [
      GarmentStatus.IN_PROCESS,
      GarmentStatus.QUALITY_CHECK,
      GarmentStatus.READY,
      GarmentStatus.OUT_FOR_DELIVERY,
      GarmentStatus.DELIVERED,
    ];
    const allPastInspection = allGarments.every(g =>
      PAST_INSPECTION.includes(g.id === garmentId ? newStatus : (g.status as GarmentStatus)),
    );
    if (allPastInspection && order.status === OrderStatus.IN_INSPECTION) {
      await this.orderRepository.updateById(order.id, {status: OrderStatus.IN_PROCESS});
      await this.orderStatusHistoryRepository.create({
        id: v4(),
        orderId: order.id,
        status: OrderStatus.IN_PROCESS,
        changedAt: now,
        changedBy,
        remarks: 'Auto-advanced: all garments completed inspection',
      });
    }
  }

  private async _stainsWithImages(garmentId: string) {
    const stains = await this.stainRepository.find({where: {garmentId, isDeleted: false}});
    return Promise.all(
      stains.map(async s => {
        const images = await this.stainImageRepository.find({where: {garmentStainId: s.id}});
        return {...s, images};
      }),
    );
  }

  private async _damagesWithImages(garmentId: string) {
    const damages = await this.damageRepository.find({where: {garmentId, isDeleted: false}});
    return Promise.all(
      damages.map(async d => {
        const images = await this.damageImageRepository.find({where: {garmentDamageId: d.id}});
        return {...d, images};
      }),
    );
  }
}
