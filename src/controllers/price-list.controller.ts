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
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
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
  @authorize({roles: ['super_admin'], permissions: ['price_list:create']})
  @post('/price-lists')
  @response(200, {
    description: 'PriceList model instance',
    content: {'application/json': {schema: getModelSchemaRef(PriceList, {includeRelations: true})}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'regionId', 'percentage'],
            properties: {
              name: {type: 'string'},
              regionId: {type: 'string', format: 'uuid'},
              percentage: {type: 'number'},
              description: {type: 'string'},
              isActive: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Omit<PriceList, 'id' | 'code'>,
  ): Promise<PriceList> {
    const all = await this.priceListRepository.find({
      fields: {code: true},
      where: {code: {like: 'RPL%'}} as any,
    });
    const maxNum = all
      .map(r => parseInt(r.code?.replace('RPL', '') || '0', 10))
      .filter(n => !Number.isNaN(n))
      .reduce((m, n) => Math.max(m, n), 0);
    const code = `RPL${String(maxNum + 1).padStart(3, '0')}`;

    body.name = (body.name as string).trim();
    const duplicate = await this.priceListRepository.findOne({where: {name: {ilike: body.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A price list with name "${body.name}" already exists.`);
    const priceList = await this.priceListRepository.create({...body, code});
    return this.priceListRepository.findById(priceList.id, {
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['price_list:read']})
  @get('/price-lists/count')
  @response(200, {
    description: 'PriceList model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(PriceList) where?: Where<PriceList>): Promise<Count> {
    return this.priceListRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['price_list:read']})
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
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['price_list:read']})
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
    @param.filter(PriceList, {exclude: 'where'}) filter?: FilterExcludingWhere<PriceList>,
  ): Promise<PriceList> {
    return this.priceListRepository.findById(id, {
      ...filter,
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['price_list:update']})
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
    if (priceList.name) {
      priceList.name = (priceList.name as string).trim();
      const duplicate = await this.priceListRepository.findOne({where: {name: {ilike: priceList.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A price list with name "${priceList.name}" already exists.`);
    }
    await this.priceListRepository.updateById(id, priceList);
  }
}
