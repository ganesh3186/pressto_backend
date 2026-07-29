import {Entity, model, property} from '@loopback/repository';

// Join table for Order <-> OrderLabel (many-to-many). Mirrors the
// CustomerLabelAssignment / UserRoles / ServiceItemMapping join-table pattern
// used elsewhere — an order can carry any number of labels, settable at
// creation or via order update.
@model({
  settings: {
    postgresql: {
      table: 'order_label_assignment',
      schema: 'public',
    },
    indexes: {
      uniqueOrderLabelAssignment: {
        keys: {orderId: 1, orderLabelId: 1},
        options: {unique: true},
      },
    },
  },
})
export class OrderLabelAssignment extends Entity {
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
  orderId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  orderLabelId: string;

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

  constructor(data?: Partial<OrderLabelAssignment>) {
    super(data);
  }
}

export interface OrderLabelAssignmentRelations {}

export type OrderLabelAssignmentWithRelations = OrderLabelAssignment &
  OrderLabelAssignmentRelations;
