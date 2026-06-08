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
import {PriceListItem} from '../models/price-list-item.model';
import {PriceListItemRepository} from '../repositories/price-list-item.repository';

export class PriceListItemController {
  constructor(
    @repository(PriceListItemRepository)
    public priceListItemRepository: PriceListItemRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/price-list-items')
  @response(200, {
    description: 'PriceListItem model instance',
    content: {'application/json': {schema: getModelSchemaRef(PriceListItem)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceListItem, {
            title: 'NewPriceListItem',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    priceListItem: Omit<PriceListItem, 'id'>,
  ): Promise<PriceListItem> {
    return this.priceListItemRepository.create(priceListItem);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-list-items/count')
  @response(200, {
    description: 'PriceListItem model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(PriceListItem) where?: Where<PriceListItem>): Promise<Count> {
    return this.priceListItemRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-list-items')
  @response(200, {
    description: 'Array of PriceListItem model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(PriceListItem, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(PriceListItem) filter?: Filter<PriceListItem>): Promise<PriceListItem[]> {
    return this.priceListItemRepository.find({
      ...filter,
      include: [
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'item', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/price-list-items')
  @response(200, {
    description: 'PriceListItem PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceListItem, {partial: true}),
        },
      },
    })
    priceListItem: PriceListItem,
    @param.where(PriceListItem) where?: Where<PriceListItem>,
  ): Promise<Count> {
    return this.priceListItemRepository.updateAll(priceListItem, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-list-items/{id}')
  @response(200, {
    description: 'PriceListItem model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(PriceListItem, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(PriceListItem, {exclude: 'where'}) filter?: FilterExcludingWhere<PriceListItem>,
  ): Promise<PriceListItem> {
    return this.priceListItemRepository.findById(id, {
      ...filter,
      include: [
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'item', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/price-list-items/{id}')
  @response(204, {description: 'PriceListItem PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceListItem, {partial: true}),
        },
      },
    })
    priceListItem: Partial<PriceListItem>,
  ): Promise<void> {
    await this.priceListItemRepository.updateById(id, priceListItem);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @del('/price-list-items/{id}')
  @response(204, {description: 'PriceListItem DELETE success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.priceListItemRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date() as any,
    } as any);
  }
}
