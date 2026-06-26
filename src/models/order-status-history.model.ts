import {Entity, model, property} from '@loopback/repository';
import {OrderStatus} from './order-status.enum';

@model({
  settings: {postgresql: {table: 'order_status_history', schema: 'public'}},
})
export class OrderStatusHistory extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(OrderStatus)},
  })
  status: OrderStatus;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  changedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  changedBy?: string;

  constructor(data?: Partial<OrderStatusHistory>) {
    super(data);
  }
}

export interface OrderStatusHistoryRelations {}
export type OrderStatusHistoryWithRelations = OrderStatusHistory & OrderStatusHistoryRelations;
