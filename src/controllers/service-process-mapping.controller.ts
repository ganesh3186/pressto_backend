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
  @authorize({roles: ['super_admin'], permissions: ['service_process_mapping:create']})
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

    // Sequence must be unique within a service — two steps can't share a position.
    if (serviceProcessMapping.sequence !== undefined) {
      const seqClash = await this.serviceProcessMappingRepository.findOne({
        where: {serviceId: serviceProcessMapping.serviceId, sequence: serviceProcessMapping.sequence, isDeleted: false},
      });
      if (seqClash) {
        throw new HttpErrors.Conflict(`Sequence ${serviceProcessMapping.sequence} is already used for this service.`);
      }
    }

    serviceProcessMapping.isInitial = serviceProcessMapping.sequence === 1;
    return this.serviceProcessMappingRepository.create(serviceProcessMapping);
  }

  @authenticate('jwt')
  @get('/service-process-mappings/by-service/{serviceId}')
  @response(200, {description: 'Process steps mapped to a service, ordered by sequence'})
  async findByService(
    @param.path.string('serviceId') serviceId: string,
  ): Promise<object[]> {
    const mappings = await this.serviceProcessMappingRepository.find({
      where: {serviceId, isDeleted: false} as any,
      order: ['sequence ASC'],
    });

    if (!mappings.length) return [];

    const stepIds = mappings.map(m => m.processStepId);
    const steps = await this.processStepRepository.find({
      where: {id: {inq: stepIds}} as any,
    });
    const stepMap = new Map(steps.map(s => [s.id, s]));

    return mappings.map(m => {
      const step = stepMap.get(m.processStepId);
      return {
        id: m.id,
        serviceId: m.serviceId,
        processStepId: m.processStepId,
        sequence: m.sequence,
        isInitial: m.isInitial,
        isMandatory: m.isMandatory,
        isActive: m.isActive,
        processStep: step
          ? {id: step.id, name: step.name, code: step.code, description: step.description}
          : null,
      };
    });
  }

  @authenticate('jwt')
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
  @authorize({roles: ['super_admin'], permissions: ['service_process_mapping:update']})
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
  @authorize({roles: ['super_admin'], permissions: ['service_process_mapping:update']})
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
    const current = await this.serviceProcessMappingRepository.findById(id);

    if (serviceProcessMapping.serviceId !== undefined || serviceProcessMapping.processStepId !== undefined) {
      const newServiceId = serviceProcessMapping.serviceId ?? current.serviceId;
      const newProcessStepId = serviceProcessMapping.processStepId ?? current.processStepId;
      const duplicate = await this.serviceProcessMappingRepository.findOne({
        where: {serviceId: newServiceId, processStepId: newProcessStepId, isDeleted: false, id: {neq: id}},
      });
      if (duplicate) {
        const [service, step] = await Promise.all([
          this.serviceRepository.findById(newServiceId),
          this.processStepRepository.findById(newProcessStepId),
        ]);
        throw new HttpErrors.Conflict(`Process step "${step.name}" is already mapped to service "${service.name}".`);
      }
    }

    // Keep sequence unique within the service when it (or the service) changes.
    if (serviceProcessMapping.sequence !== undefined || serviceProcessMapping.serviceId !== undefined) {
      const targetServiceId = serviceProcessMapping.serviceId ?? current.serviceId;
      const targetSequence = serviceProcessMapping.sequence ?? current.sequence;
      const seqClash = await this.serviceProcessMappingRepository.findOne({
        where: {serviceId: targetServiceId, sequence: targetSequence, isDeleted: false, id: {neq: id}} as any,
      });
      if (seqClash) {
        throw new HttpErrors.Conflict(`Sequence ${targetSequence} is already used for this service.`);
      }
    }

    if (serviceProcessMapping.sequence !== undefined && current.sequence !== serviceProcessMapping.sequence) {
      serviceProcessMapping.isInitial = serviceProcessMapping.sequence === 1;
    }

    await this.serviceProcessMappingRepository.updateById(id, serviceProcessMapping);
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
