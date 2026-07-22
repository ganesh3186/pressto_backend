import {Entity, belongsTo, model, property} from '@loopback/repository';
import {AddressType} from './address-type.enum';
import {Customer} from './customer.model';

@model({
  settings: {
    postgresql: {
      table: 'customer_address',
      schema: 'public',
    },
  },
})
export class CustomerAddress extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Customer)
  customerId: string;

  // What kind of place this is — see AddressType (home, office, hotel, other).
  // Left unconstrained because legacy rows still hold role values like
  // 'billing', which the business-customer GST flow depends on.
  @property({type: 'string'})
  addressType?: string;

  // What the customer calls it, e.g. "Father's home", "2nd office". Free text,
  // because two addresses can share a type and still need telling apart.
  @property({type: 'string'})
  addressName?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  addressLine1: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  addressLine2?: string;

  @property({type: 'string'})
  landmark?: string;

  @property({type: 'string', required: true})
  city: string;

  @property({type: 'string', required: true})
  state: string;

  @property({type: 'string'})
  country?: string;

  @property({type: 'string', required: true})
  pincode: string;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
  })
  latitude?: number;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
  })
  longitude?: number;

  @property({type: 'boolean', default: false})
  isDefault?: boolean;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<CustomerAddress>) {
    super(data);
  }
}

export interface CustomerAddressRelations {
  customer?: Customer;
}

export type CustomerAddressWithRelations = CustomerAddress & CustomerAddressRelations;
