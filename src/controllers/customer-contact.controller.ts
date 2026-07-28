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
import {ContactRelationship, CustomerContact} from '../models';
import {CustomerRepository} from '../repositories';
import {CustomerContactService} from '../services/customer-contact.service';

export class CustomerContactController {
  constructor(
    @inject('services.customer-contact')
    private customerContactService: CustomerContactService,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_contact:create']})
  @post('/customer-contacts')
  @response(200, {
    description: 'CustomerContact model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerContact)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerId', 'name', 'phone', 'relationship'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              name: {type: 'string'},
              phone: {type: 'string'},
              email: {type: 'string', format: 'email'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
              isPrimary: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {
      customerId: string;
      name: string;
      phone: string;
      relationship: ContactRelationship;
      email?: string;
      isPrimary?: boolean;
    },
  ): Promise<CustomerContact> {
    const {customerId, ...data} = body;
    return this.customerContactService.create(customerId, data);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_contact:read']})
  @get('/customer-contacts')
  @response(200, {
    description: 'Array of CustomerContact model instances for a customer',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(CustomerContact)},
      },
    },
  })
  async find(@param.query.string('customerId') customerId: string): Promise<CustomerContact[]> {
    if (!customerId) throw new HttpErrors.BadRequest('customerId query parameter is required');
    return this.customerContactService.findAll(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_contact:read']})
  @get('/customer-contacts/{id}')
  @response(200, {
    description: 'CustomerContact model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerContact)}},
  })
  async findById(@param.path.string('id') id: string): Promise<CustomerContact> {
    return this.customerContactService.findById(id);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_contact:update']})
  @patch('/customer-contacts/{id}')
  @response(204, {description: 'CustomerContact PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: {type: 'string'},
              phone: {type: 'string'},
              email: {type: 'string', format: 'email'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
              isPrimary: {type: 'boolean'},
              isActive: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Partial<CustomerContact>,
  ): Promise<void> {
    await this.customerContactService.update(id, body);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_contact:delete']})
  @del('/customer-contacts/{id}')
  @response(204, {description: 'CustomerContact soft delete success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.customerContactService.delete(id);
  }
}
