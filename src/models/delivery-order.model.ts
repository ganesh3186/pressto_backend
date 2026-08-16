import {Entity, model, property} from '@loopback/repository';

/**
 * One row per order in a Delivery's manifest — normalized at order
 * granularity (what the rider app actually taps: one delivery request per
 * order or batch, not per-garment), same "real, indexed lookup" reasoning
 * TransferItem already applies at garment granularity for Item Tracking.
 *
 * No status field, deliberately — see Delivery's doc comment. Completion
 * is always read live off Order.status, never duplicated here.
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
