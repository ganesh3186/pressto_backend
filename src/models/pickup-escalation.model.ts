import {Entity, model, property} from '@loopback/repository';
import {PickupEscalationStatus} from './pickup-escalation-status.enum';

/**
 * A rider-filed issue report against one of their own pickup requests —
 * the app's "Raise to support" screen. Deliberately a side-channel: filing
 * one does not block, cancel, or otherwise change the linked
 * PickupRequest's own status/transitions, it just gives support a queue
 * to triage. reason is a plain string, not an enum — the app's dropdown
 * values aren't fixed business rules anything downstream branches on, same
 * posture as PickupRequestSource-adjacent free-text fields elsewhere in
 * this model.
 */
@model({
  settings: {
    postgresql: {table: 'pickup_escalation', schema: 'public'},
  },
})
export class PickupEscalation extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  pickupRequestId: string;

  // Denormalized — safe, same reasoning as PickupHandoverItem.pickupNumber.
  @property({type: 'string'})
  pickupNumber?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderId: string;

  @property({type: 'string', required: true})
  riderName: string;

  @property({type: 'string', required: true})
  reason: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remark?: string;

  // Photos attached from the "Add item" control — same shape as
  // PickupRequest.mediaIds.
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  mediaIds?: string[];

  @property({
    type: 'string',
    default: PickupEscalationStatus.OPEN,
    jsonSchema: {enum: Object.values(PickupEscalationStatus)},
  })
  status?: PickupEscalationStatus;

  @property({type: 'date', required: true})
  raisedAt: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  raisedBy: string;

  @property({type: 'date'})
  resolvedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  resolvedBy?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  resolutionRemark?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<PickupEscalation>) {
    super(data);
  }
}

export interface PickupEscalationRelations {}
export type PickupEscalationWithRelations = PickupEscalation & PickupEscalationRelations;
