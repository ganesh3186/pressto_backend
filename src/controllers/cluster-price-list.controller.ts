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
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {ClusterPriceList} from '../models/cluster-price-list.model';
import {ClusterPriceListRepository} from '../repositories/cluster-price-list.repository';

export class ClusterPriceListController {
  constructor(
    @repository(ClusterPriceListRepository)
    public clusterPriceListRepository: ClusterPriceListRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['cluster_price_list:create']})
  @post('/cluster-price-lists')
  @response(200, {
    description: 'ClusterPriceList model instance',
    content: {'application/json': {schema: getModelSchemaRef(ClusterPriceList)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ClusterPriceList, {
            title: 'NewClusterPriceList',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    clusterPriceList: Omit<ClusterPriceList, 'id'>,
  ): Promise<ClusterPriceList> {
    const existing = await this.clusterPriceListRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const item of existing) {
      const match = item.code?.match(/^CPL(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    clusterPriceList.code = `CPL${String(maxNum + 1).padStart(3, '0')}`;
    return this.clusterPriceListRepository.create(clusterPriceList);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['cluster_price_list:read']})
  @get('/cluster-price-lists/count')
  @response(200, {
    description: 'ClusterPriceList model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(ClusterPriceList) where?: Where<ClusterPriceList>): Promise<Count> {
    return this.clusterPriceListRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['cluster_price_list:read']})
  @get('/cluster-price-lists')
  @response(200, {
    description: 'Array of ClusterPriceList model instances',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(ClusterPriceList, {includeRelations: true})},
      },
    },
  })
  async find(@param.filter(ClusterPriceList) filter?: Filter<ClusterPriceList>): Promise<ClusterPriceList[]> {
    return this.clusterPriceListRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [{relation: 'cluster', scope: {fields: {id: true, name: true, code: true}}}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['cluster_price_list:read']})
  @get('/cluster-price-lists/{id}')
  @response(200, {
    description: 'ClusterPriceList model instance',
    content: {
      'application/json': {schema: getModelSchemaRef(ClusterPriceList, {includeRelations: true})},
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ClusterPriceList, {exclude: 'where'}) filter?: FilterExcludingWhere<ClusterPriceList>,
  ): Promise<ClusterPriceList> {
    return this.clusterPriceListRepository.findById(id, {
      ...filter,
      include: [{relation: 'cluster', scope: {fields: {id: true, name: true, code: true}}}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['cluster_price_list:update']})
  @patch('/cluster-price-lists/{id}')
  @response(204, {description: 'ClusterPriceList PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ClusterPriceList, {partial: true}),
        },
      },
    })
    clusterPriceList: Partial<ClusterPriceList>,
  ): Promise<void> {
    await this.clusterPriceListRepository.updateById(id, clusterPriceList);
  }
}
