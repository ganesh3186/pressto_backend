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
import {ServiceRepository, StoreRepository, StoreServiceMappingRepository} from '../repositories';

export class StoreServiceMappingController {
  constructor(
    @repository(StoreServiceMappingRepository)
    public storeServiceMappingRepository: StoreServiceMappingRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
  @get('/store-service-mappings/count')
  @response(200, {
    description: 'StoreServiceMapping model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(@param.where(StoreServiceMapping) where?: Where<StoreServiceMapping>): Promise<Count> {
    return this.storeServiceMappingRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
