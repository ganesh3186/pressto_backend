import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Customer} from './customer.model';

@model({
  settings: {
    postgresql: {
      table: 'customer_phone',
      schema: 'public',
    },
  },
})
export class CustomerPhone extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Customer)
  customerId: string;

  @property({type: 'string', required: true})
  countryCode: string;

  @property({type: 'string', required: true})
  phone: string;

  @property({type: 'boolean', default: false})
  isPrimary?: boolean;

  @property({type: 'boolean', default: false})
  isWhatsappNumber?: boolean;

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

  constructor(data?: Partial<CustomerPhone>) {
    super(data);
  }
}

export interface CustomerPhoneRelations {
  customer?: Customer;
}

export type CustomerPhoneWithRelations = CustomerPhone & CustomerPhoneRelations;
