import { authenticate } from '@loopback/authentication';
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
import { authorize } from '../authorization';
import { ServiceItemMapping } from '../models/service-item-mapping.model';
import { ServiceItemMappingRepository } from '../repositories/service-item-mapping.repository';

export class ServiceItemMappingController {
  constructor(
    @repository(ServiceItemMappingRepository)
    public serviceItemMappingRepository: ServiceItemMappingRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/service-item-mappings')
  @response(200, {
    description: 'ServiceItemMapping model instance',
    content: {
      'application/json': { schema: getModelSchemaRef(ServiceItemMapping) },
    },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceItemMapping, {
            title: 'NewServiceItemMapping',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    serviceItemMapping: Omit<ServiceItemMapping, 'id'>,
  ): Promise<ServiceItemMapping> {
    return this.serviceItemMappingRepository.create(serviceItemMapping);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-item-mappings/count')
  @response(200, {
    description: 'ServiceItemMapping model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(ServiceItemMapping) where?: Where<ServiceItemMapping>,
  ): Promise<Count> {
    return this.serviceItemMappingRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-item-mappings')
  @response(200, {
    description: 'Array of ServiceItemMapping model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(ServiceItemMapping, {
            includeRelations: true,
          }),
        },
      },
    },
  })
  async find(
    @param.filter(ServiceItemMapping) filter?: Filter<ServiceItemMapping>,
  ): Promise<ServiceItemMapping[]> {
    return this.serviceItemMappingRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-item-mappings')
  @response(200, {
    description: 'ServiceItemMapping PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceItemMapping, { partial: true }),
        },
      },
    })
    serviceItemMapping: ServiceItemMapping,
    @param.where(ServiceItemMapping) where?: Where<ServiceItemMapping>,
  ): Promise<Count> {
    return this.serviceItemMappingRepository.updateAll(
      serviceItemMapping,
      where,
    );
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-item-mappings/{id}')
  @response(200, {
    description: 'ServiceItemMapping model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(ServiceItemMapping, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ServiceItemMapping, { exclude: 'where' })
    filter?: FilterExcludingWhere<ServiceItemMapping>,
  ): Promise<ServiceItemMapping> {
    return this.serviceItemMappingRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-item-mappings/{id}')
  @response(204, { description: 'ServiceItemMapping PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceItemMapping, { partial: true }),
        },
      },
    })
    serviceItemMapping: ServiceItemMapping,
  ): Promise<void> {
    await this.serviceItemMappingRepository.updateById(id, serviceItemMapping);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/service-item-mappings/{id}')
  // @response(204, {description: 'ServiceItemMapping PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() serviceItemMapping: ServiceItemMapping,
  // ): Promise<void> {
  //   await this.serviceItemMappingRepository.replaceById(id, serviceItemMapping);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/service-item-mappings/{id}')
  // @response(204, {description: 'ServiceItemMapping DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.serviceItemMappingRepository.deleteById(id);
  // }
}
