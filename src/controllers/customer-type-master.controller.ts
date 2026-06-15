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
import {CustomerTypeMaster} from '../models';
import {CustomerTypeMasterRepository} from '../repositories';

export class CustomerTypeMasterController {
  constructor(
    @repository(CustomerTypeMasterRepository)
    public customerTypeMasterRepository: CustomerTypeMasterRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/customer-type-masters')
  @response(200, {
    description: 'CustomerTypeMaster model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerTypeMaster)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerTypeMaster, {
            title: 'NewCustomerTypeMaster',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    customerTypeMaster: Omit<CustomerTypeMaster, 'id'>,
  ): Promise<CustomerTypeMaster> {
    return this.customerTypeMasterRepository.create(customerTypeMaster);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-type-masters/count')
  @response(200, {
    description: 'CustomerTypeMaster model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(CustomerTypeMaster) where?: Where<CustomerTypeMaster>,
  ): Promise<Count> {
    return this.customerTypeMasterRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-type-masters')
  @response(200, {
    description: 'Array of CustomerTypeMaster model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(CustomerTypeMaster, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(CustomerTypeMaster) filter?: Filter<CustomerTypeMaster>,
  ): Promise<CustomerTypeMaster[]> {
    return this.customerTypeMasterRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-type-masters')
  @response(200, {
    description: 'CustomerTypeMaster PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerTypeMaster, {partial: true}),
        },
      },
    })
    customerTypeMaster: CustomerTypeMaster,
    @param.where(CustomerTypeMaster) where?: Where<CustomerTypeMaster>,
  ): Promise<Count> {
    return this.customerTypeMasterRepository.updateAll(customerTypeMaster, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-type-masters/{id}')
  @response(200, {
    description: 'CustomerTypeMaster model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(CustomerTypeMaster, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(CustomerTypeMaster, {exclude: 'where'})
    filter?: FilterExcludingWhere<CustomerTypeMaster>,
  ): Promise<CustomerTypeMaster> {
    return this.customerTypeMasterRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-type-masters/{id}')
  @response(204, {description: 'CustomerTypeMaster PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerTypeMaster, {partial: true}),
        },
      },
    })
    customerTypeMaster: Partial<CustomerTypeMaster>,
  ): Promise<void> {
    await this.customerTypeMasterRepository.updateById(id, customerTypeMaster);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/customer-type-masters/{id}')
  // @response(204, {description: 'CustomerTypeMaster DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.customerTypeMasterRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
