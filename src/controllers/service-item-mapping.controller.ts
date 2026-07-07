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
  HttpErrors,
  param,
  patch,
  post,
  put,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { ServiceItemMapping } from '../models/service-item-mapping.model';
import { ItemRepository, ServiceItemMappingRepository, ServiceRepository } from '../repositories';

export class ServiceItemMappingController {
  constructor(
    @repository(ServiceItemMappingRepository)
    public serviceItemMappingRepository: ServiceItemMappingRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
    @repository(ItemRepository)
    private itemRepository: ItemRepository,
  ) { }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:create']})
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
    const existing = await this.serviceItemMappingRepository.findOne({
      where: {serviceId: serviceItemMapping.serviceId, itemId: serviceItemMapping.itemId, isDeleted: false},
    });
    if (existing) {
      const [service, item] = await Promise.all([
        this.serviceRepository.findById(serviceItemMapping.serviceId),
        this.itemRepository.findById(serviceItemMapping.itemId),
      ]);
      throw new HttpErrors.Conflict(
        `A mapping for "${service.name}" → "${item.name}" already exists.`,
      );
    }
    return this.serviceItemMappingRepository.create(serviceItemMapping);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:read']})
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
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:read']})
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
  ): Promise<object[]> {
    const mappings = await this.serviceItemMappingRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
    return this._withAdditionalServices(mappings);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:update']})
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
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:read']})
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
  ): Promise<object> {
    const mapping = await this.serviceItemMappingRepository.findById(id, filter);
    const [resolved] = await this._withAdditionalServices([mapping]);
    return resolved;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['service_item_mapping:update']})
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
    if (serviceItemMapping.serviceId !== undefined || serviceItemMapping.itemId !== undefined) {
      const current = await this.serviceItemMappingRepository.findById(id);
      const newServiceId = serviceItemMapping.serviceId ?? current.serviceId;
      const newItemId = serviceItemMapping.itemId ?? current.itemId;
      const duplicate = await this.serviceItemMappingRepository.findOne({
        where: {serviceId: newServiceId, itemId: newItemId, isDeleted: false, id: {neq: id}},
      });
      if (duplicate) {
        const [service, item] = await Promise.all([
          this.serviceRepository.findById(newServiceId),
          this.itemRepository.findById(newItemId),
        ]);
        throw new HttpErrors.Conflict(`A mapping for "${service.name}" → "${item.name}" already exists.`);
      }
    }
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

  private async _withAdditionalServices(mappings: ServiceItemMapping[]): Promise<object[]> {
    const allIds = [...new Set(mappings.flatMap(m => m.additionalServiceIds ?? []))];
    const serviceMap: Record<string, {id: string; name: string; code: string}> = {};
    if (allIds.length) {
      const services = await this.serviceRepository.find({
        where: {id: {inq: allIds}},
        fields: {id: true, name: true, code: true} as any,
      });
      for (const s of services) serviceMap[s.id] = {id: s.id, name: s.name, code: s.code};
    }
    return mappings.map(m => ({
      ...m,
      additionalServices: (m.additionalServiceIds ?? []).map(sid => serviceMap[sid]).filter(Boolean),
    }));
  }
}
