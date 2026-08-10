import {authenticate} from '@loopback/authentication';
import {Count, CountSchema, Filter, FilterExcludingWhere, repository, Where} from '@loopback/repository';
import {del, get, getModelSchemaRef, param, patch, post, requestBody, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {PickupDeliverySlot} from '../models/pickup-delivery-slot.model';
import {PickupDeliverySlotRepository} from '../repositories/pickup-delivery-slot.repository';

export class PickupDeliverySlotController {
  constructor(
    @repository(PickupDeliverySlotRepository)
    public slotRepository: PickupDeliverySlotRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_delivery_slot:create']})
  @post('/pickup-delivery-slots')
  @response(200, {
    description: 'PickupDeliverySlot model instance',
    content: {'application/json': {schema: getModelSchemaRef(PickupDeliverySlot)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PickupDeliverySlot, {
            title: 'NewPickupDeliverySlot',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    slot: Omit<PickupDeliverySlot, 'id'>,
  ): Promise<PickupDeliverySlot> {
    const {v4} = await import('uuid');
    return this.slotRepository.create({...slot, id: v4()});
  }

  @authenticate('jwt')
  @get('/pickup-delivery-slots/count')
  @response(200, {
    description: 'PickupDeliverySlot model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(PickupDeliverySlot) where?: Where<PickupDeliverySlot>): Promise<Count> {
    return this.slotRepository.count({...where, isDeleted: false} as Where<PickupDeliverySlot>);
  }

  @authenticate('jwt')
  @get('/pickup-delivery-slots')
  @response(200, {
    description: 'Array of PickupDeliverySlot model instances',
    content: {
      'application/json': {schema: {type: 'array', items: getModelSchemaRef(PickupDeliverySlot)}},
    },
  })
  async find(@param.filter(PickupDeliverySlot) filter?: Filter<PickupDeliverySlot>): Promise<PickupDeliverySlot[]> {
    return this.slotRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]} as Where<PickupDeliverySlot>,
      order: filter?.order ?? ['sortOrder ASC', 'startTime ASC'],
    });
  }

  @authenticate('jwt')
  @get('/pickup-delivery-slots/{id}')
  @response(200, {
    description: 'PickupDeliverySlot model instance',
    content: {'application/json': {schema: getModelSchemaRef(PickupDeliverySlot)}},
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(PickupDeliverySlot, {exclude: 'where'}) filter?: FilterExcludingWhere<PickupDeliverySlot>,
  ): Promise<PickupDeliverySlot> {
    return this.slotRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_delivery_slot:update']})
  @patch('/pickup-delivery-slots/{id}')
  @response(204, {description: 'PickupDeliverySlot PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {'application/json': {schema: getModelSchemaRef(PickupDeliverySlot, {partial: true})}},
    })
    slot: Partial<PickupDeliverySlot>,
  ): Promise<void> {
    await this.slotRepository.updateById(id, slot);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_delivery_slot:delete']})
  @del('/pickup-delivery-slots/{id}')
  @response(204, {description: 'PickupDeliverySlot DELETE success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.slotRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
    });
  }
}
