import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {postgresql: {table: 'order_additional_charge', schema: 'public'}},
})
export class OrderAdditionalCharge extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  additionalChargeId: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'number', required: true, default: 1, postgresql: {dataType: 'integer'}})
  quantity: number;

  @property({type: 'string'})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<OrderAdditionalCharge>) {
    super(data);
  }
}

export interface OrderAdditionalChargeRelations {}
export type OrderAdditionalChargeWithRelations = OrderAdditionalCharge & OrderAdditionalChargeRelations;
