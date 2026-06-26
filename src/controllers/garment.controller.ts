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
import {Severity} from '../models/severity.enum';
import {
  GarmentDamageRepository,
  GarmentImageRepository,
  GarmentRepository,
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
    @repository(GarmentStainRepository) private stainRepository: GarmentStainRepository,
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

    const orderItem = await this.orderItemRepository.findOne({
      where: {id: orderItemId, orderId},
    });
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    // Check garment count doesn't exceed item quantity
    const existingCount = await this.garmentRepository.count({
      orderItemId,
      isDeleted: false,
    });
    if (existingCount.count >= orderItem.quantity) {
      throw new HttpErrors.BadRequest(
        `All ${orderItem.quantity} garments for this order item have already been registered.`,
      );
    }

    // Generate tag number: GT + 8-digit global sequence
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
          this.damageRepository.find({where: {garmentId: g.id, isDeleted: false}}),
          this.stainRepository.find({where: {garmentId: g.id, isDeleted: false}}),
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
    const garment = await this.garmentRepository.findOne({
      where: {id: garmentId, isDeleted: false},
    });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const [damages, stains, images, statusHistory] = await Promise.all([
      this.damageRepository.find({where: {garmentId, isDeleted: false}}),
      this.stainRepository.find({where: {garmentId, isDeleted: false}}),
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
            },
          },
        },
      },
    })
    body: {brandId?: string; colorId?: string; qrCode?: string; customerRemarks?: string; inspectionRemarks?: string},
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

  // ─── Damage ───────────────────────────────────────────────────────────────

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
            required: ['damageTypeId', 'severity'],
            properties: {
              damageTypeId: {type: 'string', format: 'uuid'},
              severity: {type: 'string', enum: Object.values(Severity)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {damageTypeId: string; severity: Severity; remarks?: string},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    const damage = await this.damageRepository.create({garmentId, ...body});
    return {message: 'Damage recorded.', damage};
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

  // ─── Stain ────────────────────────────────────────────────────────────────

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
            required: ['stainId', 'severity'],
            properties: {
              stainId: {type: 'string', format: 'uuid'},
              severity: {type: 'string', enum: Object.values(Severity)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {stainId: string; severity: Severity; remarks?: string},
  ): Promise<object> {
    const garment = await this.garmentRepository.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    const stain = await this.stainRepository.create({garmentId, ...body});
    return {message: 'Stain recorded.', stain};
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

  // ─── Images ───────────────────────────────────────────────────────────────

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
}
