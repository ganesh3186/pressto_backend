import {Entity, model, property} from '@loopback/repository';
import {DeliveryOrderStatus} from './delivery-order-status.enum';

/**
 * One row per order in a Delivery's manifest — normalized at order
 * granularity (what the rider app actually taps: one delivery request per
 * order or batch, not per-garment), same "real, indexed lookup" reasoning
 * TransferItem already applies at garment granularity for Item Tracking.
 *
 * Completion is still always read live off Order.status, never duplicated
 * here — status/arrivedAt below are the one deliberate exception: a
 * "rider has physically reached this stop" breadcrumb that Order.status
 * has no room for, scoped per-stop since one Delivery run covers several
 * orders that are reached at different times.
 */
@model({
  settings: {
    postgresql: {table: 'delivery_order', schema: 'public'},
    indexes: {
      deliveryOrderLookup: {keys: ['orderId']},
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

  // Optional at the type level only so adding this column doesn't require
  // a NOT NULL backfill migration for rows that predate this field — a
  // null/missing value on an existing row reads as 'pending', same as the
  // default new rows get. Set to 'arrived' via
  // PATCH /rider/deliveries/{id}/orders/{orderId}/status.
  @property({
    type: 'string',
    default: DeliveryOrderStatus.PENDING,
    jsonSchema: {enum: Object.values(DeliveryOrderStatus)},
  })
  status?: DeliveryOrderStatus;

  @property({type: 'date'})
  arrivedAt?: Date;

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
