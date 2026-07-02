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
import {OrderLabel} from '../models/order-label.model';
import {OrderLabelRepository} from '../repositories/order-label.repository';

export class OrderLabelController {
  constructor(
    @repository(OrderLabelRepository)
    public orderLabelRepository: OrderLabelRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/order-labels')
  @response(200, {
    description: 'OrderLabel model instance',
    content: {'application/json': {schema: getModelSchemaRef(OrderLabel)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(OrderLabel, {
            title: 'NewOrderLabel',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    orderLabel: Omit<OrderLabel, 'id'>,
  ): Promise<OrderLabel> {
    const existing = await this.orderLabelRepository.findOne({where: {code: orderLabel.code, isDeleted: false}});
    if (existing) throw new HttpErrors.Conflict(`An order label with code "${orderLabel.code}" already exists.`);
    return this.orderLabelRepository.create(orderLabel);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/order-labels/count')
  @response(200, {
    description: 'OrderLabel model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(OrderLabel) where?: Where<OrderLabel>,
  ): Promise<Count> {
    return this.orderLabelRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/order-labels')
  @response(200, {
    description: 'Array of OrderLabel model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(OrderLabel, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(OrderLabel) filter?: Filter<OrderLabel>,
  ): Promise<OrderLabel[]> {
    return this.orderLabelRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/order-labels')
  @response(200, {
    description: 'OrderLabel PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(OrderLabel, {partial: true}),
        },
      },
    })
    orderLabel: OrderLabel,
    @param.where(OrderLabel) where?: Where<OrderLabel>,
  ): Promise<Count> {
    return this.orderLabelRepository.updateAll(orderLabel, where);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/order-labels/{id}')
  @response(200, {
    description: 'OrderLabel model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(OrderLabel, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(OrderLabel, {exclude: 'where'})
    filter?: FilterExcludingWhere<OrderLabel>,
  ): Promise<OrderLabel> {
    return this.orderLabelRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/order-labels/{id}')
  @response(204, {description: 'OrderLabel PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(OrderLabel, {partial: true}),
        },
      },
    })
    orderLabel: Partial<OrderLabel>,
  ): Promise<void> {
    await this.orderLabelRepository.updateById(id, orderLabel);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/order-labels/{id}')
  // @response(204, {description: 'OrderLabel DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.orderLabelRepository.updateById(id, {
  //     isDeleted: true,
  //     isActive: false,
  //     deletedAt: new Date() as any,
  //   } as any);
  // }
}
