import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'customer_family_group',
      schema: 'public',
    },
    indexes: {
      uniqueFamilyGroupPrimaryCustomer: {
        keys: ['primaryCustomerId'],
        options: {unique: true},
      },
    },
  },
})
export class CustomerFamilyGroup extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  primaryCustomerId: string;

  @property({type: 'string'})
  name?: string;

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

  constructor(data?: Partial<CustomerFamilyGroup>) {
    super(data);
  }
}

export interface CustomerFamilyGroupRelations {}

export type CustomerFamilyGroupWithRelations = CustomerFamilyGroup &
  CustomerFamilyGroupRelations;
