import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {
  get,
  getModelSchemaRef,
  HttpErrors,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {DeliveryTypeConfiguration} from '../models/delivery-type-configuration.model';
import {DeliveryTypeConfigurationRepository} from '../repositories/delivery-type-configuration.repository';

export class DeliveryTypeConfigurationController {
  constructor(
    @repository(DeliveryTypeConfigurationRepository)
    public deliveryTypeConfigurationRepository: DeliveryTypeConfigurationRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/delivery-type-configuration')
  @response(200, {
    description: 'DeliveryTypeConfiguration model instance',
    content: {'application/json': {schema: getModelSchemaRef(DeliveryTypeConfiguration)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(DeliveryTypeConfiguration, {
            title: 'NewDeliveryTypeConfiguration',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    config: Omit<DeliveryTypeConfiguration, 'id'>,
  ): Promise<DeliveryTypeConfiguration> {
    const existing = await this.deliveryTypeConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (existing) {
      throw new HttpErrors.Conflict(
        'Delivery Type Configuration already exists. Use PATCH to update it.',
      );
    }
    return this.deliveryTypeConfigurationRepository.create(config);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/delivery-type-configuration')
  @response(200, {
    description: 'DeliveryTypeConfiguration singleton',
    content: {'application/json': {schema: getModelSchemaRef(DeliveryTypeConfiguration)}},
  })
  async find(): Promise<DeliveryTypeConfiguration> {
    const config = await this.deliveryTypeConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!config) {
      throw new HttpErrors.NotFound('Delivery Type Configuration has not been set up yet.');
    }
    return config;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/delivery-type-configuration')
  @response(204, {description: 'DeliveryTypeConfiguration PATCH success'})
  async update(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(DeliveryTypeConfiguration, {partial: true}),
        },
      },
    })
    config: Partial<DeliveryTypeConfiguration>,
  ): Promise<void> {
    const existing = await this.deliveryTypeConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!existing) {
      throw new HttpErrors.NotFound('Delivery Type Configuration has not been set up yet.');
    }
    await this.deliveryTypeConfigurationRepository.updateById(existing.id, config);
  }
}
