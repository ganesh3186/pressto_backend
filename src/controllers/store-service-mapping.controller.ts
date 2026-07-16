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
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {StoreServiceMapping} from '../models/store-service-mapping.model';
import {
  OrderItemRepository,
  OrderRepository,
  ServiceRepository,
  StoreRepository,
  StoreServiceMappingRepository,
} from '../repositories';

export class StoreServiceMappingController {
  constructor(
    @repository(StoreServiceMappingRepository)
    public storeServiceMappingRepository: StoreServiceMappingRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(OrderItemRepository)
    private orderItemRepository: OrderItemRepository,
  ) {}

  // ─── Store service capacity (available vs filled) ──────────────────────────
  // Per service configured for a store: dailyCapacity vs how much is already
  // booked for a given delivery date. "Filled" = sum of order-item quantities on
  // that store's non-cancelled orders whose delivery date matches. Display only
  // (the Create Order screen shows available/filled; no hard block here).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:read']})
  @get('/stores/{storeId}/service-capacity')
  @response(200, {description: 'Per-service capacity (available / filled) for a store on a date'})
  async serviceCapacity(
    @param.path.string('storeId') storeId: string,
    @param.query.string('date') date?: string,
  ): Promise<object> {
    const store = await this.storeRepository.findOne({where: {id: storeId, isDeleted: false}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const mappings = await this.storeServiceMappingRepository.find({
      where: {storeId, isActive: true, isDeleted: false} as any,
    });
    if (!mappings.length) return {storeId, date: date ?? null, services: []};

    // Orders for this store on the target delivery date (default: today).
    const day = date ? new Date(date) : new Date();
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59, 999);

    const orders = await this.orderRepository.find({
      where: {
        storeId,
        isDeleted: false,
        status: {neq: 'cancelled'},
        deliveryDate: {between: [dayStart, dayEnd]},
      } as any,
      fields: {id: true} as any,
    });

    // Sum booked quantity per service across those orders' items.
    const filledByService = new Map<string, number>();
    if (orders.length) {
      const items = await this.orderItemRepository.find({
        where: {orderId: {inq: orders.map(o => o.id)}} as any,
        fields: {serviceId: true, quantity: true} as any,
      });
      for (const it of items) {
        filledByService.set(it.serviceId, (filledByService.get(it.serviceId) ?? 0) + (Number(it.quantity) || 0));
      }
    }

    const serviceIds = mappings.map(m => m.serviceId);
    const services = await this.serviceRepository.find({where: {id: {inq: serviceIds}} as any});
    const serviceNameById = new Map(services.map(s => [s.id, s.name]));

    const rows = mappings.map(m => {
      const capacity = Number(m.dailyCapacity) || 0;
      const filled = filledByService.get(m.serviceId) ?? 0;
      return {
        serviceId: m.serviceId,
        serviceName: serviceNameById.get(m.serviceId) ?? null,
        capacity,
        filled,
        available: Math.max(0, capacity - filled),
        isFull: capacity > 0 && filled >= capacity,
      };
    });

    return {storeId, date: dayStart.toISOString().slice(0, 10), services: rows};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:create']})
  @post('/store-service-mappings')
  @response(200, {
    description: 'StoreServiceMapping model instance',
    content: {'application/json': {schema: getModelSchemaRef(StoreServiceMapping)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StoreServiceMapping, {
            title: 'NewStoreServiceMapping',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    storeServiceMapping: Omit<StoreServiceMapping, 'id'>,
  ): Promise<StoreServiceMapping> {
    const existing = await this.storeServiceMappingRepository.findOne({
      where: {storeId: storeServiceMapping.storeId, serviceId: storeServiceMapping.serviceId, isDeleted: false},
    });
    if (existing) {
      const [store, service] = await Promise.all([
        this.storeRepository.findById(storeServiceMapping.storeId),
        this.serviceRepository.findById(storeServiceMapping.serviceId),
      ]);
      throw new HttpErrors.Conflict(
        `Service "${service.name}" is already mapped to store "${store.name}".`,
      );
    }
    return this.storeServiceMappingRepository.create(storeServiceMapping);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:read']})
  @get('/store-service-mappings/count')
  @response(200, {
    description: 'StoreServiceMapping model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(StoreServiceMapping) where?: Where<StoreServiceMapping>): Promise<Count> {
    return this.storeServiceMappingRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:read']})
  @get('/store-service-mappings')
  @response(200, {
    description: 'Array of StoreServiceMapping model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(StoreServiceMapping, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(StoreServiceMapping) filter?: Filter<StoreServiceMapping>): Promise<StoreServiceMapping[]> {
    return this.storeServiceMappingRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:update']})
  @patch('/store-service-mappings')
  @response(200, {
    description: 'StoreServiceMapping PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StoreServiceMapping, {partial: true}),
        },
      },
    })
    storeServiceMapping: StoreServiceMapping,
    @param.where(StoreServiceMapping) where?: Where<StoreServiceMapping>,
  ): Promise<Count> {
    return this.storeServiceMappingRepository.updateAll(storeServiceMapping, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:read']})
  @get('/store-service-mappings/{id}')
  @response(200, {
    description: 'StoreServiceMapping model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(StoreServiceMapping, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(StoreServiceMapping, {exclude: 'where'}) filter?: FilterExcludingWhere<StoreServiceMapping>,
  ): Promise<StoreServiceMapping> {
    return this.storeServiceMappingRepository.findById(id, {
      ...filter,
      include: [
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
        {relation: 'service', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['store_service_mapping:update']})
  @patch('/store-service-mappings/{id}')
  @response(204, {description: 'StoreServiceMapping PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(StoreServiceMapping, {partial: true}),
        },
      },
    })
    storeServiceMapping: Partial<StoreServiceMapping>,
  ): Promise<void> {
    const current = await this.storeServiceMappingRepository.findOne({where: {id, isDeleted: false}});
    if (!current) throw new HttpErrors.NotFound('Store-service mapping not found.');
    if (storeServiceMapping.storeId !== undefined || storeServiceMapping.serviceId !== undefined) {
      const newStoreId = storeServiceMapping.storeId ?? current.storeId;
      const newServiceId = storeServiceMapping.serviceId ?? current.serviceId;
      const duplicate = await this.storeServiceMappingRepository.findOne({
        where: {storeId: newStoreId, serviceId: newServiceId, isDeleted: false, id: {neq: id}},
      });
      if (duplicate) {
        const [store, service] = await Promise.all([
          this.storeRepository.findById(newStoreId),
          this.serviceRepository.findById(newServiceId),
        ]);
        throw new HttpErrors.Conflict(`Service "${service.name}" is already mapped to store "${store.name}".`);
      }
    }
    await this.storeServiceMappingRepository.updateById(id, storeServiceMapping);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/store-service-mappings/{id}')
  // @response(204, {description: 'StoreServiceMapping DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.storeServiceMappingRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
