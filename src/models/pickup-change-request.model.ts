import {Entity, model, property} from '@loopback/repository';
import {PickupChangeRequestStatus} from './pickup-change-request-status.enum';

/**
 * A record of the real order (built on POS) deviating from what the
 * customer's pickup request actually said — e.g. pickup confirmed
 * "Clean × 2" but the store added a 3rd item while building the order.
 * Write-once audit record, same posture as OrderStatusHistory — never
 * edited after creation, no soft-delete.
 *
 * Does NOT send anything to the customer — there is no SMS/WhatsApp/push
 * channel in this backend yet (only email, used solely for OTP). This is
 * purely the persisted fact of what changed, for whoever eventually
 * builds real customer notification on top of it (or for admin/support
 * to review). `status` stays PENDING forever until that exists.
 */
@model({
  settings: {postgresql: {table: 'pickup_change_request', schema: 'public'}},
})
export class PickupChangeRequest extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  pickupRequestId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  customerId?: string;

  // Snapshot of what the pickup said (actualItemsByService, or
  // itemCategoryEstimate if the rider never confirmed real counts) at the
  // moment the order was compared against it.
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  originalItems: object[];

  // What actually got built into the order.
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  changedItems: object[];

  // Human-readable diff, e.g. "Added: Wash & Fold × 1; Changed: Clean × 2 → × 3".
  @property({type: 'string', postgresql: {dataType: 'text'}})
  changeSummary?: string;

  @property({
    type: 'string',
    default: PickupChangeRequestStatus.PENDING,
    jsonSchema: {enum: Object.values(PickupChangeRequestStatus)},
  })
  status?: PickupChangeRequestStatus;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  createdBy: string;

  constructor(data?: Partial<PickupChangeRequest>) {
    super(data);
  }
}

export interface PickupChangeRequestRelations {}
export type PickupChangeRequestWithRelations = PickupChangeRequest & PickupChangeRequestRelations;
