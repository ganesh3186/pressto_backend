import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Customer} from './customer.model';
import {Order} from './order.model';
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

  // Free string — no slot master exists anywhere in this codebase yet;
  // matches the same "6 fixed label" convention used elsewhere.
  @property({type: 'string', required: true})
  slot: string;

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
}

export type PickupRequestWithRelations = PickupRequest & PickupRequestRelations;
