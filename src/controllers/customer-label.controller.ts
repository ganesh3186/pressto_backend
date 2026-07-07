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
import {CustomerLabel} from '../models/customer-label.model';
import {CustomerLabelRepository} from '../repositories/customer-label.repository';

export class CustomerLabelController {
  constructor(
    @repository(CustomerLabelRepository)
    public customerLabelRepository: CustomerLabelRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/customer-labels')
  @response(200, {
    description: 'CustomerLabel model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerLabel)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerLabel, {
            title: 'NewCustomerLabel',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    customerLabel: Omit<CustomerLabel, 'id'>,
  ): Promise<CustomerLabel> {
    const existing = await this.customerLabelRepository.find({fields: {code: true}});
    let maxNum = 0;
    for (const l of existing) {
      const match = l.code?.match(/^CLBL(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    customerLabel.name = (customerLabel.name as string).trim();
    const duplicate = await this.customerLabelRepository.findOne({where: {name: {ilike: customerLabel.name}, isDeleted: false}});
    if (duplicate) throw new HttpErrors.Conflict(`A customer label with name "${customerLabel.name}" already exists.`);
    customerLabel.code = `CLBL${String(maxNum + 1).padStart(3, '0')}`;
    return this.customerLabelRepository.create(customerLabel);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-labels/count')
  @response(200, {
    description: 'CustomerLabel model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(CustomerLabel) where?: Where<CustomerLabel>,
  ): Promise<Count> {
    return this.customerLabelRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-labels')
  @response(200, {
    description: 'Array of CustomerLabel model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(CustomerLabel, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(CustomerLabel) filter?: Filter<CustomerLabel>,
  ): Promise<CustomerLabel[]> {
    return this.customerLabelRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-labels')
  @response(200, {
    description: 'CustomerLabel PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerLabel, {partial: true}),
        },
      },
    })
    customerLabel: CustomerLabel,
    @param.where(CustomerLabel) where?: Where<CustomerLabel>,
  ): Promise<Count> {
    return this.customerLabelRepository.updateAll(customerLabel, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/customer-labels/{id}')
  @response(200, {
    description: 'CustomerLabel model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(CustomerLabel, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(CustomerLabel, {exclude: 'where'})
    filter?: FilterExcludingWhere<CustomerLabel>,
  ): Promise<CustomerLabel> {
    return this.customerLabelRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/customer-labels/{id}')
  @response(204, {description: 'CustomerLabel PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(CustomerLabel, {partial: true}),
        },
      },
    })
    customerLabel: Partial<CustomerLabel>,
  ): Promise<void> {
    if (customerLabel.name) {
      customerLabel.name = (customerLabel.name as string).trim();
      const duplicate = await this.customerLabelRepository.findOne({where: {name: {ilike: customerLabel.name}, isDeleted: false, id: {neq: id}} as any});
      if (duplicate) throw new HttpErrors.Conflict(`A customer label with name "${customerLabel.name}" already exists.`);
    }
    await this.customerLabelRepository.updateById(id, customerLabel);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/customer-labels/{id}')
  // @response(204, {description: 'CustomerLabel DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.customerLabelRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
