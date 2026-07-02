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
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { ServiceProcessMapping } from '../models/service-process-mapping.model';
import { ProcessStepRepository, ServiceProcessMappingRepository, ServiceRepository } from '../repositories';

export class ServiceProcessMappingController {
  constructor(
    @repository(ServiceProcessMappingRepository)
    public serviceProcessMappingRepository: ServiceProcessMappingRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
    @repository(ProcessStepRepository)
    private processStepRepository: ProcessStepRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/service-process-mappings')
  @response(200, {
    description: 'ServiceProcessMapping model instance',
    content: {
      'application/json': { schema: getModelSchemaRef(ServiceProcessMapping) },
    },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceProcessMapping, {
            title: 'NewServiceProcessMapping',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    serviceProcessMapping: Omit<ServiceProcessMapping, 'id'>,
  ): Promise<ServiceProcessMapping> {
    const existing = await this.serviceProcessMappingRepository.findOne({
      where: {serviceId: serviceProcessMapping.serviceId, processStepId: serviceProcessMapping.processStepId, isDeleted: false},
    });
    if (existing) {
      const [service, step] = await Promise.all([
        this.serviceRepository.findById(serviceProcessMapping.serviceId),
        this.processStepRepository.findById(serviceProcessMapping.processStepId),
      ]);
      throw new HttpErrors.Conflict(
        `Process step "${step.name}" is already mapped to service "${service.name}".`,
      );
    }
    serviceProcessMapping.isInitial = serviceProcessMapping.sequence === 1;
    return this.serviceProcessMappingRepository.create(serviceProcessMapping);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-process-mappings/count')
  @response(200, {
    description: 'ServiceProcessMapping model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(ServiceProcessMapping) where?: Where<ServiceProcessMapping>,
  ): Promise<Count> {
    return this.serviceProcessMappingRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-process-mappings')
  @response(200, {
    description: 'Array of ServiceProcessMapping model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(ServiceProcessMapping, {
            includeRelations: true,
          }),
        },
      },
    },
  })
  async find(
    @param.filter(ServiceProcessMapping) filter?: Filter<ServiceProcessMapping>,
  ): Promise<ServiceProcessMapping[]> {
    return this.serviceProcessMappingRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-process-mappings')
  @response(200, {
    description: 'ServiceProcessMapping PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceProcessMapping, { partial: true }),
        },
      },
    })
    serviceProcessMapping: ServiceProcessMapping,
    @param.where(ServiceProcessMapping) where?: Where<ServiceProcessMapping>,
  ): Promise<Count> {
    return this.serviceProcessMappingRepository.updateAll(
      serviceProcessMapping,
      where,
    );
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/service-process-mappings/{id}')
  @response(200, {
    description: 'ServiceProcessMapping model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(ServiceProcessMapping, {
          includeRelations: true,
        }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(ServiceProcessMapping, { exclude: 'where' })
    filter?: FilterExcludingWhere<ServiceProcessMapping>,
  ): Promise<ServiceProcessMapping> {
    return this.serviceProcessMappingRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/service-process-mappings/{id}')
  @response(204, { description: 'ServiceProcessMapping PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(ServiceProcessMapping, { partial: true }),
        },
      },
    })
    serviceProcessMapping: Partial<ServiceProcessMapping>,
  ): Promise<void> {
    if (serviceProcessMapping.sequence !== undefined) {
      const old = await this.serviceProcessMappingRepository.findById(id);
      if (old.sequence !== serviceProcessMapping.sequence) {
        serviceProcessMapping.isInitial = serviceProcessMapping.sequence === 1;
      }
    }
    await this.serviceProcessMappingRepository.updateById(
      id,
      serviceProcessMapping,
    );
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/service-process-mappings/{id}')
  // @response(204, {description: 'ServiceProcessMapping PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() serviceProcessMapping: ServiceProcessMapping,
  // ): Promise<void> {
  //   await this.serviceProcessMappingRepository.replaceById(
  //     id,
  //     serviceProcessMapping,
  //   );
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/service-process-mappings/{id}')
  // @response(204, {description: 'ServiceProcessMapping DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.serviceProcessMappingRepository.deleteById(id);
  // }
}
