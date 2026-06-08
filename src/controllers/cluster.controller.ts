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
import {Cluster} from '../models/cluster.model';
import {ClusterRepository} from '../repositories/cluster.repository';

export class ClusterController {
  constructor(
    @repository(ClusterRepository)
    public clusterRepository: ClusterRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/clusters')
  @response(200, {
    description: 'Cluster model instance',
    content: {'application/json': {schema: getModelSchemaRef(Cluster)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Cluster, {
            title: 'NewCluster',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    cluster: Omit<Cluster, 'id'>,
  ): Promise<Cluster> {
    return this.clusterRepository.create(cluster);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/clusters/count')
  @response(200, {
    description: 'Cluster model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(Cluster) where?: Where<Cluster>): Promise<Count> {
    return this.clusterRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/clusters')
  @response(200, {
    description: 'Array of Cluster model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Cluster, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(Cluster) filter?: Filter<Cluster>,
  ): Promise<Cluster[]> {
    return this.clusterRepository.find({
      ...filter,
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/clusters')
  @response(200, {
    description: 'Cluster PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Cluster, {partial: true}),
        },
      },
    })
    cluster: Cluster,
    @param.where(Cluster) where?: Where<Cluster>,
  ): Promise<Count> {
    return this.clusterRepository.updateAll(cluster, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/clusters/{id}')
  @response(200, {
    description: 'Cluster model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Cluster, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Cluster, {exclude: 'where'})
    filter?: FilterExcludingWhere<Cluster>,
  ): Promise<Cluster> {
    return this.clusterRepository.findById(id, {
      ...filter,
      include: [{relation: 'region'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/clusters/{id}')
  @response(204, {description: 'Cluster PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Cluster, {partial: true}),
        },
      },
    })
    cluster: Partial<Cluster>,
  ): Promise<void> {
    await this.clusterRepository.updateById(id, cluster);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/clusters/{id}')
  // @response(204, {description: 'Cluster DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.clusterRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
