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
import {PriceList} from '../models/price-list.model';
import {PriceListType} from '../models/price-list-type.enum';
import {PriceListRepository} from '../repositories/price-list.repository';
import {PriceListItemRepository} from '../repositories/price-list-item.repository';

export class PriceListController {
  constructor(
    @repository(PriceListRepository)
    public priceListRepository: PriceListRepository,
    @repository(PriceListItemRepository)
    public priceListItemRepository: PriceListItemRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/price-lists')
  @response(200, {
    description: 'PriceList model instance (with optional items)',
    content: {'application/json': {schema: getModelSchemaRef(PriceList, {includeRelations: true})}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'code', 'regionId', 'priceListType'],
            properties: {
              name: {type: 'string'},
              code: {type: 'string'},
              regionId: {type: 'string', format: 'uuid'},
              priceListType: {type: 'string', enum: Object.values(PriceListType)},
              description: {type: 'string'},
              isActive: {type: 'boolean'},
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['serviceId', 'itemId', 'price'],
                  properties: {
                    serviceId: {type: 'string', format: 'uuid'},
                    itemId: {type: 'string', format: 'uuid'},
                    price: {type: 'number'},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: Omit<PriceList, 'id'> & {items?: Array<{serviceId: string; itemId: string; price: number}>},
  ): Promise<PriceList> {
    const {items, ...priceListData} = body;
    const priceList = await this.priceListRepository.create(priceListData);

    if (items && items.length > 0) {
      await Promise.all(
        items.map(item =>
          this.priceListItemRepository.create({
            priceListId: priceList.id,
            serviceId: item.serviceId,
            itemId: item.itemId,
            price: item.price,
          }),
        ),
      );
    }

    return this.priceListRepository.findById(priceList.id, {
      include: [{relation: 'region'}, {relation: 'priceListItems'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-lists/count')
  @response(200, {
    description: 'PriceList model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(PriceList) where?: Where<PriceList>): Promise<Count> {
    return this.priceListRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-lists')
  @response(200, {
    description: 'Array of PriceList model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(PriceList, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(PriceList) filter?: Filter<PriceList>): Promise<PriceList[]> {
    return this.priceListRepository.find({
      ...filter,
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/price-lists')
  @response(200, {
    description: 'PriceList PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceList, {partial: true}),
        },
      },
    })
    priceList: PriceList,
    @param.where(PriceList) where?: Where<PriceList>,
  ): Promise<Count> {
    return this.priceListRepository.updateAll(priceList, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-lists/{id}')
  @response(200, {
    description: 'PriceList model instance with region and items',
    content: {
      'application/json': {
        schema: getModelSchemaRef(PriceList, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(PriceList, {exclude: 'where'}) filter?: FilterExcludingWhere<PriceList>,
  ): Promise<PriceList> {
    return this.priceListRepository.findById(id, {
      ...filter,
      include: [
        {relation: 'region'},
        {
          relation: 'priceListItems',
          scope: {
            include: [
              {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
              {relation: 'item', scope: {fields: {id: true, name: true, code: true}}},
            ],
          },
        },
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/price-lists/{id}')
  @response(204, {description: 'PriceList PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceList, {partial: true}),
        },
      },
    })
    priceList: Partial<PriceList>,
  ): Promise<void> {
    await this.priceListRepository.updateById(id, priceList);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/price-lists/{id}')
  // @response(204, {description: 'PriceList DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.priceListRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
