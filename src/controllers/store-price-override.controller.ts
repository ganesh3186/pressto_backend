import {authenticate} from '@loopback/authentication';
import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {StorePriceOverride} from '../models/store-price-override.model';
import {StorePriceOverrideRepository} from '../repositories/store-price-override.repository';

export class StorePriceOverrideController {
  constructor(
    @repository(StorePriceOverrideRepository)
    public storePriceOverrideRepository: StorePriceOverrideRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/store-price-overrides')
  @response(200, {
    description: 'StorePriceOverride model instance',
    content: {'application/json': {schema: getModelSchemaRef(StorePriceOverride)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StorePriceOverride, {
            title: 'NewStorePriceOverride',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    storePriceOverride: Omit<StorePriceOverride, 'id'>,
  ): Promise<StorePriceOverride> {
    return this.storePriceOverrideRepository.create(storePriceOverride);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/store-price-overrides/count')
  @response(200, {
    description: 'StorePriceOverride model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(StorePriceOverride) where?: Where<StorePriceOverride>): Promise<Count> {
    return this.storePriceOverrideRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/store-price-overrides')
  @response(200, {
    description: 'Array of StorePriceOverride model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(StorePriceOverride, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(StorePriceOverride) filter?: Filter<StorePriceOverride>): Promise<StorePriceOverride[]> {
    return this.storePriceOverrideRepository.find({
      ...filter,
      include: [
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'item', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/store-price-overrides')
  @response(200, {
    description: 'StorePriceOverride PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StorePriceOverride, {partial: true}),
        },
      },
    })
    storePriceOverride: StorePriceOverride,
    @param.where(StorePriceOverride) where?: Where<StorePriceOverride>,
  ): Promise<Count> {
    return this.storePriceOverrideRepository.updateAll(storePriceOverride, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/store-price-overrides/{id}')
  @response(200, {
    description: 'StorePriceOverride model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(StorePriceOverride, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(StorePriceOverride, {exclude: 'where'}) filter?: FilterExcludingWhere<StorePriceOverride>,
  ): Promise<StorePriceOverride> {
    return this.storePriceOverrideRepository.findById(id, {
      ...filter,
      include: [
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'item', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/store-price-overrides/{id}')
  @response(204, {description: 'StorePriceOverride PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StorePriceOverride, {partial: true}),
        },
      },
    })
    storePriceOverride: Partial<StorePriceOverride>,
  ): Promise<void> {
    await this.storePriceOverrideRepository.updateById(id, storePriceOverride);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @del('/store-price-overrides/{id}')
  @response(204, {description: 'StorePriceOverride DELETE success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.storePriceOverrideRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date() as any,
    } as any);
  }
}
