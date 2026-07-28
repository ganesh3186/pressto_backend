import {authenticate} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
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
import {CustomerPhone} from '../models';
import {CustomerRepository} from '../repositories';
import {CustomerPhoneService} from '../services/customer-phone.service';

export class CustomerPhoneController {
  constructor(
    @inject('services.customer-phone')
    private customerPhoneService: CustomerPhoneService,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_phone:create']})
  @post('/customer-phones')
  @response(200, {
    description: 'CustomerPhone model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerPhone)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerId', 'countryCode', 'phone'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              countryCode: {type: 'string', default: '+91'},
              phone: {type: 'string'},
              isPrimary: {type: 'boolean'},
              isWhatsappNumber: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {
      customerId: string;
      countryCode: string;
      phone: string;
      isPrimary?: boolean;
      isWhatsappNumber?: boolean;
    },
  ): Promise<CustomerPhone> {
    const {customerId, ...data} = body;
    return this.customerPhoneService.create(customerId, data);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_phone:read']})
  @get('/customer-phones')
  @response(200, {
    description: 'Array of CustomerPhone model instances for a customer',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(CustomerPhone)},
      },
    },
  })
  async find(@param.query.string('customerId') customerId: string): Promise<CustomerPhone[]> {
    if (!customerId) throw new HttpErrors.BadRequest('customerId query parameter is required');
    return this.customerPhoneService.findAll(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_phone:read']})
  @get('/customer-phones/{id}')
  @response(200, {
    description: 'CustomerPhone model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerPhone)}},
  })
  async findById(@param.path.string('id') id: string): Promise<CustomerPhone> {
    return this.customerPhoneService.findById(id);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_phone:update']})
  @patch('/customer-phones/{id}')
  @response(204, {description: 'CustomerPhone PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              isPrimary: {type: 'boolean'},
              isWhatsappNumber: {type: 'boolean'},
              isActive: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Partial<CustomerPhone>,
  ): Promise<void> {
    await this.customerPhoneService.update(id, body);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_phone:delete']})
  @del('/customer-phones/{id}')
  @response(204, {description: 'CustomerPhone soft delete success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.customerPhoneService.delete(id);
  }
}
