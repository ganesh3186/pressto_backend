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
import {
  GarmentDamageImageRepository,
  GarmentDamageRepository,
  GarmentImageRepository,
  GarmentRepository,
  GarmentStainImageRepository,
  GarmentStainRepository,
  GarmentStatusHistoryRepository,
  OrderItemRepository,
  OrderRepository,
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
  ) {}

  // ─── Register Garments for an Order Item ──────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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

  // ─── Get Single Garment ───────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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

  // ─── Update Garment ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
    },
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    await this.garmentRepository.updateById(garmentId, body);
    return {message: 'Garment updated.'};
  }

  // ─── Change Garment Status ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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

    return {message: `Garment status changed to '${body.status}'.`};
  }

  // ─── Stains ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
