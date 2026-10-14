import {Entity, model, property} from '@loopback/repository';
import {DeliveryOrderStatus} from './delivery-order-status.enum';

/**
 * One row per order in a Delivery's manifest — normalized at order
 * granularity (what the rider app actually taps: one delivery request per
 * order or batch, not per-garment), same "real, indexed lookup" reasoning
 * TransferItem already applies at garment granularity for Item Tracking.
 *
 * Status records each stop's progress and outcome independently of Order.status.
 */
@model({
  settings: {
    postgresql: {table: 'delivery_order', schema: 'public'},
    indexes: {
      deliveryOrderLookup: {keys: ['orderId']},
      deliveryOrderDeliveryId: {keys: ['deliveryId']},
    },
  },
})
export class DeliveryOrder extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  deliveryId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  // Denormalized snapshot — safe: Order.orderNumber is assigned once and
  // never reused.
  @property({type: 'string', required: true})
  orderNumber: string;

  @property({type: 'string', required: true})
  customerName: string;

  @property({type: 'string'})
  customerMobile?: string;

  // Display snapshot only, taken at assignment time — never authoritative.
  // The live Order.balanceDue (via computeBalanceDue()) is the real value
  // at delivery time; this field exists only so a list screen doesn't need
  // to join every Order just to show what was owed when the run started.
  @property({type: 'number'})
  balanceDueAtAssignment?: number;

  // Existing rows without a status read as pending.
  @property({
    type: 'string',
    default: DeliveryOrderStatus.PENDING,
    jsonSchema: {enum: Object.values(DeliveryOrderStatus)},
  })
  status?: DeliveryOrderStatus;

  @property({type: 'date'})
  arrivedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  failureRemarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<DeliveryOrder>) {
    super(data);
  }
}

export interface DeliveryOrderRelations {}
export type DeliveryOrderWithRelations = DeliveryOrder & DeliveryOrderRelations;
