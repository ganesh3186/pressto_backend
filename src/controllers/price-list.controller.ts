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
  put,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {PriceList} from '../models/price-list.model';
import {PriceListRepository} from '../repositories/price-list.repository';

export class PriceListController {
  constructor(
    @repository(PriceListRepository)
    public priceListRepository: PriceListRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/price-lists')
  @response(200, {
    description: 'PriceList model instance',
    content: {'application/json': {schema: getModelSchemaRef(PriceList)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(PriceList, {
            title: 'NewPriceList',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    priceList: Omit<PriceList, 'id'>,
  ): Promise<PriceList> {
    return this.priceListRepository.create(priceList);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/price-lists/count')
  @response(200, {
    description: 'PriceList model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(PriceList) where?: Where<PriceList>,
  ): Promise<Count> {
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
  async find(
    @param.filter(PriceList) filter?: Filter<PriceList>,
  ): Promise<PriceList[]> {
    return this.priceListRepository.find(filter);
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
    description: 'PriceList model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(PriceList, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(PriceList, {exclude: 'where'})
    filter?: FilterExcludingWhere<PriceList>,
  ): Promise<PriceList> {
    return this.priceListRepository.findById(id, filter);
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
    priceList: PriceList,
  ): Promise<void> {
    await this.priceListRepository.updateById(id, priceList);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @put('/price-lists/{id}')
  @response(204, {description: 'PriceList PUT success'})
  async replaceById(
    @param.path.string('id') id: string,
    @requestBody() priceList: PriceList,
  ): Promise<void> {
    await this.priceListRepository.replaceById(id, priceList);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @del('/price-lists/{id}')
  @response(204, {description: 'PriceList DELETE success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.priceListRepository.deleteById(id);
  }
}
