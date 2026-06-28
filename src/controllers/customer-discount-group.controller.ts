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
import {CustomerDiscountGroup} from '../models/customer-discount-group.model';
import {CustomerDiscountGroupRepository} from '../repositories/customer-discount-group.repository';

export class CustomerDiscountGroupController {
  constructor(
    @repository(CustomerDiscountGroupRepository)
    public customerDiscountGroupRepository: CustomerDiscountGroupRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/customer-discount-groups')
  @response(200, {
    description: 'CustomerDiscountGroup model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerDiscountGroup)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerDiscountGroup, {
            title: 'NewCustomerDiscountGroup',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    customerDiscountGroup: Omit<CustomerDiscountGroup, 'id'>,
  ): Promise<CustomerDiscountGroup> {
    const existing = await this.customerDiscountGroupRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const g of existing) {
      const match = g.code?.match(/^CDG(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    customerDiscountGroup.code = `CDG${String(maxNum + 1).padStart(3, '0')}`;
    return this.customerDiscountGroupRepository.create(customerDiscountGroup);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-discount-groups/count')
  @response(200, {
    description: 'CustomerDiscountGroup model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(CustomerDiscountGroup) where?: Where<CustomerDiscountGroup>,
  ): Promise<Count> {
    return this.customerDiscountGroupRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-discount-groups')
  @response(200, {
    description: 'Array of CustomerDiscountGroup model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(CustomerDiscountGroup, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(CustomerDiscountGroup) filter?: Filter<CustomerDiscountGroup>,
  ): Promise<CustomerDiscountGroup[]> {
    return this.customerDiscountGroupRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-discount-groups')
  @response(200, {
    description: 'CustomerDiscountGroup PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerDiscountGroup, {partial: true}),
        },
      },
    })
    customerDiscountGroup: CustomerDiscountGroup,
    @param.where(CustomerDiscountGroup) where?: Where<CustomerDiscountGroup>,
  ): Promise<Count> {
    return this.customerDiscountGroupRepository.updateAll(customerDiscountGroup, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-discount-groups/{id}')
  @response(200, {
    description: 'CustomerDiscountGroup model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(CustomerDiscountGroup, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(CustomerDiscountGroup, {exclude: 'where'})
    filter?: FilterExcludingWhere<CustomerDiscountGroup>,
  ): Promise<CustomerDiscountGroup> {
    return this.customerDiscountGroupRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-discount-groups/{id}')
  @response(204, {description: 'CustomerDiscountGroup PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerDiscountGroup, {partial: true}),
        },
      },
    })
    customerDiscountGroup: Partial<CustomerDiscountGroup>,
  ): Promise<void> {
    await this.customerDiscountGroupRepository.updateById(id, customerDiscountGroup);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/customer-discount-groups/{id}')
  // @response(204, {description: 'CustomerDiscountGroup DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.customerDiscountGroupRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
