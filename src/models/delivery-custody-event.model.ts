import {Entity, model, property} from '@loopback/repository';

/**
 * Custody/trail audit log for a Delivery — same shape as
 * TransferCustodyEvent, one row per lifecycle/order event.
 */
@model({settings: {postgresql: {table: 'delivery_custody_event', schema: 'public'}}})
export class DeliveryCustodyEvent extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  deliveryId: string;

  // Set only for order-level events (order_delivered/order_delivery_failed).
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  orderId?: string;

  // DeliveryCustodyEventType, stored as a plain string like
  // TransferCustodyEvent.eventType does.
  @property({type: 'string', required: true})
  eventType: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  performedBy: string;

  @property({type: 'date', defaultFn: 'now'})
  performedAt?: Date;

  constructor(data?: Partial<DeliveryCustodyEvent>) {
    super(data);
  }
}

export interface DeliveryCustodyEventRelations {}
export type DeliveryCustodyEventWithRelations = DeliveryCustodyEvent & DeliveryCustodyEventRelations;
