import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {postgresql: {table: 'order_item', schema: 'public'}},
})
export class OrderItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  serviceId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  itemId: string;

  @property({type: 'number', required: true})
  quantity: number;

  // Raw base price from ServiceItemMapping at time of order (audit trail)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  basePrice?: number;

  // Which price level was applied: store | cluster | region | base
  @property({type: 'string'})
  priceSource?: string;

  // The percentage multiplier applied from the matched price list (null if base)
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  appliedPercentage?: number;

  // Resolved price after price list (before express multiplier)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  resolvedPrice?: number;

  // Final unit price = resolvedPrice × expressMultiplier
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  unitPrice?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  totalPrice?: number;

  // Text part of special instruction for this item
  @property({type: 'string', postgresql: {dataType: 'text'}})
  specialInstructions?: string;

  // Media IDs (uploaded images) attached to this item's special instruction
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  specialInstructionMediaIds?: string[];

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<OrderItem>) {
    super(data);
  }
}

export interface OrderItemRelations {}
export type OrderItemWithRelations = OrderItem & OrderItemRelations;
