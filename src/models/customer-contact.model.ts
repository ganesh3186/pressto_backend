import {Entity, belongsTo, model, property} from '@loopback/repository';
import {ContactRelationship} from './contact-relationship.enum';
import {Customer} from './customer.model';

@model({
  settings: {
    postgresql: {
      table: 'customer_contact',
      schema: 'public',
    },
  },
})
export class CustomerContact extends Entity {
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
  name: string;

  @property({type: 'string', required: true})
  phone: string;

  @property({type: 'string'})
  email?: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {
      enum: Object.values(ContactRelationship),
    },
  })
  relationship: ContactRelationship;

  @property({type: 'boolean', default: false})
  isPrimary?: boolean;

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

  constructor(data?: Partial<CustomerContact>) {
    super(data);
  }
}

export interface CustomerContactRelations {
  customer?: Customer;
}

export type CustomerContactWithRelations = CustomerContact & CustomerContactRelations;
