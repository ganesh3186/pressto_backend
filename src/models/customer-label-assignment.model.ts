import {Entity, model, property} from '@loopback/repository';

// Join table for Customer <-> CustomerLabel (many-to-many). A customer used to
// carry a single customerLabelId FK directly on the customer table — this
// replaces that with an unlimited set of labels per customer, mirroring the
// UserRoles / ServiceItemMapping join-table pattern used elsewhere.
@model({
  settings: {
    postgresql: {
      table: 'customer_label_assignment',
      schema: 'public',
    },
    indexes: {
      uniqueCustomerLabelAssignment: {
        keys: {customerId: 1, customerLabelId: 1},
        options: {unique: true},
      },
    },
  },
})
export class CustomerLabelAssignment extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  customerId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  customerLabelId: string;

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

  constructor(data?: Partial<CustomerLabelAssignment>) {
    super(data);
  }
}

export interface CustomerLabelAssignmentRelations {}

export type CustomerLabelAssignmentWithRelations = CustomerLabelAssignment &
  CustomerLabelAssignmentRelations;
