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
import {CustomerAddress} from '../models';
import {CustomerRepository} from '../repositories';
import {CustomerAddressService} from '../services/customer-address.service';

export class CustomerAddressController {
  constructor(
    @inject('services.customer-address')
    private customerAddressService: CustomerAddressService,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_address:create']})
  @post('/customer-addresses')
  @response(200, {
    description: 'CustomerAddress model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerAddress)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerId', 'addressLine1', 'city', 'state', 'pincode'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              addressType: {type: 'string'},
              addressName: {type: 'string', description: "e.g. Father's home, 2nd office"},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              landmark: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              country: {type: 'string'},
              pincode: {type: 'string'},
              latitude: {type: 'number'},
              longitude: {type: 'number'},
              isDefault: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {
      customerId: string;
      // See AddressType — not typed as the enum while legacy role values
      // ('billing', 'primary') still flow through this field.
      addressType?: string;
      addressName?: string;
      addressLine1: string;
      addressLine2?: string;
      landmark?: string;
      city: string;
      state: string;
      country?: string;
      pincode: string;
      latitude?: number;
      longitude?: number;
      isDefault?: boolean;
    },
  ): Promise<CustomerAddress> {
    const {customerId, ...data} = body;
    return this.customerAddressService.create(customerId, data);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_address:read']})
  @get('/customer-addresses')
  @response(200, {
    description: 'Array of CustomerAddress model instances for a customer',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(CustomerAddress)},
      },
    },
  })
  async find(@param.query.string('customerId') customerId: string): Promise<CustomerAddress[]> {
    if (!customerId) throw new HttpErrors.BadRequest('customerId query parameter is required');
    return this.customerAddressService.findAll(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_address:read']})
  @get('/customer-addresses/{id}')
  @response(200, {
    description: 'CustomerAddress model instance',
    content: {'application/json': {schema: getModelSchemaRef(CustomerAddress)}},
  })
  async findById(@param.path.string('id') id: string): Promise<CustomerAddress> {
    return this.customerAddressService.findById(id);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_address:update']})
  @patch('/customer-addresses/{id}')
  @response(204, {description: 'CustomerAddress PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              addressType: {type: 'string'},
              addressName: {type: 'string', description: "e.g. Father's home, 2nd office"},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              landmark: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              country: {type: 'string'},
              pincode: {type: 'string'},
              latitude: {type: 'number'},
              longitude: {type: 'number'},
              isDefault: {type: 'boolean'},
              isActive: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Partial<CustomerAddress>,
  ): Promise<void> {
    await this.customerAddressService.update(id, body);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_address:delete']})
  @del('/customer-addresses/{id}')
  @response(204, {description: 'CustomerAddress soft delete success'})
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.customerAddressService.delete(id);
  }
}
