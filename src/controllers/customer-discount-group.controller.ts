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
  HttpErrors,
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

  private assertValidDiscount(discountPercentage?: number, maxDiscountAmount?: number) {
    if (discountPercentage !== undefined && (discountPercentage <= 0 || discountPercentage > 100)) {
      throw new HttpErrors.BadRequest('Discount percentage must be greater than 0 and at most 100.');
    }
    if (maxDiscountAmount !== undefined && maxDiscountAmount !== null && maxDiscountAmount <= 0) {
      throw new HttpErrors.BadRequest('Max discount amount must be greater than 0 when given.');
    }
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_discount_group:create']})
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
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
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
    customerDiscountGroup.name = (customerDiscountGroup.name as string).trim();
    const duplicate = await this.customerDiscountGroupRepository.findOne({where: {name: {ilike: customerDiscountGroup.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A customer discount group with name "${customerDiscountGroup.name}" already exists.`);
    this.assertValidDiscount(customerDiscountGroup.discountPercentage, customerDiscountGroup.maxDiscountAmount);
    customerDiscountGroup.code = `CDG${String(maxNum + 1).padStart(3, '0')}`;
    return this.customerDiscountGroupRepository.create(customerDiscountGroup);
  }

  @authenticate('jwt')
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
    return this.customerDiscountGroupRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_discount_group:update']})
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
  @authorize({roles: ['super_admin'], permissions: ['customer_discount_group:update']})
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
    if (customerDiscountGroup.name) {
      customerDiscountGroup.name = (customerDiscountGroup.name as string).trim();
      const duplicate = await this.customerDiscountGroupRepository.findOne({where: {name: {ilike: customerDiscountGroup.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A customer discount group with name "${customerDiscountGroup.name}" already exists.`);
    }
    this.assertValidDiscount(customerDiscountGroup.discountPercentage, customerDiscountGroup.maxDiscountAmount);
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
