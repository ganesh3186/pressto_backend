import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Customer} from './customer.model';
import {Order} from './order.model';
import {PickupDeliverySlot} from './pickup-delivery-slot.model';
import {PickupHandoverBy} from './pickup-handover-by.enum';
import {PickupRequestSource} from './pickup-request-source.enum';
import {PickupRequestStatus} from './pickup-request-status.enum';
import {Rider} from './rider.model';
import {Store} from './store.model';

/**
 * A request for a rider to collect a customer's items — BEFORE any Order
 * exists. Once the rider brings the items to the store, staff build the
 * real Order there (service/items/pricing/inspection); convertedOrderId is
 * a placeholder for that future link, nothing writes to it yet.
 *
 * One rider assignment can cover several pickup requests in a single trip —
 * runId groups whichever requests were assigned together in one
 * POST /pickup-requests/assign call. It is not a separate table: nothing
 * today needs run-level aggregates (distance, ETA, route order) — that's
 * Rider Tracking territory, explicitly deferred.
 */
@model({
  settings: {
    postgresql: {table: 'pickup_request', schema: 'public'},
  },
})
export class PickupRequest extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // May be absent — a call/WhatsApp intake often has no Customer row yet.
  @belongsTo(() => Customer)
  customerId?: string;

  // Always populated, even when customerId is set — a snapshot, same
  // reasoning as OrderHandover.collectorName next to customerContactId.
  @property({type: 'string', required: true})
  customerName: string;

  @property({type: 'string', default: '+91'})
  customerCountryCode?: string;

  @property({type: 'string', required: true})
  customerMobile: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  address: string;

  @property({type: 'string'})
  pincode?: string;

  @property({type: 'date', required: true})
  requestedDate: string;

  // Denormalized display snapshot of slotId's PickupDeliverySlot.label,
  // resolved server-side when slotId is supplied. Stays a required free
  // string for backward compat with rows created before the Slot master
  // existed and with admin/rider flows that still pass it directly.
  @property({type: 'string', required: true})
  slot: string;

  // Authoritative slot reference going forward — @belongsTo, matching this
  // model's existing convention for its other FK fields (customerId,
  // storeId, assignedRiderId). Named pickupSlotId, not slotId — LB4 derives
  // the belongsTo relation name by stripping the trailing "Id", which would
  // otherwise collide with the existing `slot` string property above.
  @belongsTo(() => PickupDeliverySlot)
  pickupSlotId?: string;

  // Destination store — optional at creation (a call-center intake often
  // doesn't know which store will process it yet), required by the
  // /assign endpoint (a rider assignment must resolve to a concrete
  // "bring it here").
  @belongsTo(() => Store)
  storeId?: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(PickupRequestSource)},
  })
  source: PickupRequestSource;

  @property({
    type: 'string',
    default: PickupRequestStatus.REQUESTED,
    jsonSchema: {enum: Object.values(PickupRequestStatus)},
  })
  status?: PickupRequestStatus;

  @property({type: 'number'})
  itemCountEstimate?: number;

  // Who hands the garments to the rider — required by the customer-facing
  // create flow only (§3 of the Logistics plan); admin/rider-originated
  // requests leave this unset since neither intake path collects it.
  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(PickupHandoverBy)},
  })
  handoverBy?: PickupHandoverBy;

  // Required (validated in the controller) when handoverBy is anything
  // other than 'self'.
  @property({type: 'string'})
  handoverPersonName?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  // Shared by every request assigned to one rider in the same
  // POST /pickup-requests/assign call — lets the UI display/query them as
  // one trip without a separate PickupRun table.
  @property({type: 'string'})
  runId?: string;

  @belongsTo(() => Rider)
  assignedRiderId?: string;

  @property({type: 'date'})
  assignedAt?: Date;

  // The acting user's id (users.id) — a plain uuid, not a FK relation,
  // matching how OrderHandover.handedOverBy denormalizes the actor.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  assignedBy?: string;

  // Placeholder only — set by a future intake flow, not this pass.
  @belongsTo(() => Order)
  convertedOrderId?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<PickupRequest>) {
    super(data);
  }
}

export interface PickupRequestRelations {
  customer?: Customer;
  store?: Store;
  assignedRider?: Rider;
  convertedOrder?: Order;
  pickupSlot?: PickupDeliverySlot;
}

export type PickupRequestWithRelations = PickupRequest & PickupRequestRelations;
