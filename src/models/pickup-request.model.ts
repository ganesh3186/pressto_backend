import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Customer} from './customer.model';
import {DeliveryGroupingPreference} from './delivery-grouping-preference.enum';
import {DeliveryType} from './delivery-type.enum';
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
    indexes: {
      uniquePickupNumber: {keys: ['pickupNumber'], options: {unique: true}},
    },
  },
})
export class PickupRequest extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // 'PU{seq6}' — server-generated, human-readable, shown in the admin UI
  // instead of the raw id. Optional at the type level only so adding this
  // column doesn't require a NOT NULL backfill migration; the create()
  // controller always sets it, so in practice every row has one.
  @property({type: 'string'})
  pickupNumber?: string;

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

  // Per-category breakdown (e.g. how many clothes vs curtains) — used to
  // size a pickup (bike vs van). itemCountEstimate stays as the plain
  // aggregate for backward compat; this is the richer optional detail.
  // serviceId/deliverySpeed are pure estimate metadata for the store exec
  // who builds the real Order later — nothing downstream reads them yet,
  // same posture as the rest of this field. Both optional so the existing
  // customer-facing flow (itemCategoryId + quantity only) is unaffected.
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  itemCategoryEstimate?: Array<{
    itemCategoryId: string;
    quantity: number;
    serviceId?: string;
    deliverySpeed?: DeliveryType;
  }>;

  // Customer's pre-declared preference for whether a multi-item pickup
  // should be delivered together or as-and-when-ready — same "estimate
  // for the store exec" posture as itemCategoryEstimate above.
  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(DeliveryGroupingPreference)},
  })
  deliveryGroupingPreference?: DeliveryGroupingPreference;

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

  // Media IDs (uploaded photos/voice notes) attached to the pickup request's
  // special instructions — same shape as Order.specialInstructionMediaIds.
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  mediaIds?: string[];

  // Shared by every request assigned to one rider in the same
  // POST /pickup-requests/assign call — lets the UI display/query them as
  // one trip without a separate PickupRun table.
  @property({type: 'string'})
  runId?: string;

  // Human-readable label for runId ('RUN{seq6}', same shape as PU/ORD
  // numbers) — runId itself stays a uuid grouping key, this is display-only,
  // set alongside it in assign().
  @property({type: 'string'})
  runNumber?: string;

  @belongsTo(() => Rider)
  assignedRiderId?: string;

  // Denormalized snapshot of assignedRiderId's Rider name, set in assign() —
  // GET /pickup-requests doesn't `include` the assignedRider relation, so
  // without this the admin table would show "Not assigned" even once a
  // rider is actually assigned.
  @property({type: 'string'})
  assignedRiderName?: string;

  @property({type: 'date'})
  assignedAt?: Date;

  // The acting user's id (users.id) — a plain uuid, not a FK relation,
  // matching how OrderHandover.handedOverBy denormalizes the actor.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  assignedBy?: string;

  // Set once the store exec creates the real Order from this pickup
  // request (admin PATCH /pickup-requests/{id} {convertedOrderId}) — see
  // pickup-request.controller.ts's updateById() guard against overwriting
  // an already-set value.
  @belongsTo(() => Order)
  convertedOrderId?: string;

  // Real bag the rider used for this pickup — plain uuid, not @belongsTo,
  // matching Transfer's fromStoreId/toStoreId/bagId convention (batch-
  // resolve display names at read time rather than relying on auto
  // `include`). Set together with actualItemsByService when the rider
  // confirms pickup (PATCH .../status {status: 'picked_up'}); released
  // back to the Bag's own AVAILABLE state when the pickup reaches
  // received_at_store.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  bagId?: string;

  // Rider-confirmed real counts at the doorstep, by service — set
  // alongside bagId. Distinct from itemCategoryEstimate above: that one is
  // the customer's pre-arrival guess, by category, collected at booking
  // time; this is the rider's actual count, by service, collected at
  // pickup time. serviceName is a snapshot, same denormalization
  // convention as assignedRiderName alongside assignedRiderId below.
  // deliverySpeed is optional — the real speed confirmed with the customer
  // at the door, when the rider app sends it; store staff should build the
  // real order against this, not the (possibly stale) pre-arrival estimate.
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  actualItemsByService?: Array<{
    serviceId: string;
    serviceName?: string;
    quantity: number;
    deliverySpeed?: DeliveryType;
  }>;

  // Set together when the rider marks status: pickup_unsuccessful — see
  // PickupUnsuccessfulReason. unsuccessfulOtherReason is free text, only
  // meaningful when unsuccessfulReasons includes 'other'.
  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  unsuccessfulReasons?: string[];

  @property({type: 'string', postgresql: {dataType: 'text'}})
  unsuccessfulOtherReason?: string;

  @property({type: 'date'})
  unsuccessfulAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  unsuccessfulBy?: string;

  // How many times POST .../reprocess has sent this back out — purely a
  // display counter, doesn't gate anything.
  @property({type: 'number', default: 0})
  reprocessCount?: number;

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
