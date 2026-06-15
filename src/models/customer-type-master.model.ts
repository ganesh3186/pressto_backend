import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'customer_type_master',
      schema: 'public',
    },
    indexes: {
      uniqueCustomerTypeValue: {
        keys: ['value'],
        options: {unique: true},
      },
    },
  },
})
export class CustomerTypeMaster extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', required: true})
  value: string;

  @property({type: 'string'})
  description?: string;

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

  constructor(data?: Partial<CustomerTypeMaster>) {
    super(data);
  }
}

export interface CustomerTypeMasterRelations {}

export type CustomerTypeMasterWithRelations = CustomerTypeMaster & CustomerTypeMasterRelations;
