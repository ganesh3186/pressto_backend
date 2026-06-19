import {Entity, model, property} from '@loopback/repository';
import {ContactRelationship} from './contact-relationship.enum';

@model({
  settings: {
    postgresql: {
      table: 'customer_family_group_member',
      schema: 'public',
    },
  },
})
export class CustomerFamilyGroupMember extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  groupId: string;

  // Linked to an existing customer account; optional if member is not yet registered
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  customerId?: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string'})
  phone?: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(ContactRelationship)},
  })
  relationship: ContactRelationship;

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

  constructor(data?: Partial<CustomerFamilyGroupMember>) {
    super(data);
  }
}

export interface CustomerFamilyGroupMemberRelations {}

export type CustomerFamilyGroupMemberWithRelations = CustomerFamilyGroupMember &
  CustomerFamilyGroupMemberRelations;
