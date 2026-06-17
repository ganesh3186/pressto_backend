import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'order_label',
      schema: 'public',
    },
    indexes: {
      uniqueOrderLabelCode: {
        keys: ['code'],
        options: {unique: true},
      },
    },
  },
})
export class OrderLabel extends Entity {
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
  code: string;

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

  constructor(data?: Partial<OrderLabel>) {
    super(data);
  }
}

export interface OrderLabelRelations {}

export type OrderLabelWithRelations = OrderLabel & OrderLabelRelations;
