import {Entity, model, property} from '@loopback/repository';
import {PickupHandoverStatus} from './pickup-handover-status.enum';
import {PickupHandoverTargetType} from './pickup-handover-target-type.enum';

/**
 * Batch header for garments a rider has picked up and is handing over —
 * the rider app's "Handover orders" screen selects several of the rider's
 * own PICKED_UP pickup requests, picks who it's going to (a store, or
 * another rider/van), and submits them as one of these. Mirrors
 * RiderCashHandover's header/line-item split exactly, one layer up (whole
 * pickup requests instead of payment transactions).
 *
 * Confirmation is QR/code-based, not tap-to-confirm — handoverCode is
 * shown as text + encoded into a QR on the rider's screen; the receiver
 * (store staff scanning on the admin panel, or another rider scanning/
 * entering it on their own app) resolves by that code, not by id, since
 * they may not have the id on hand at all until they scan.
 *
 * Does not itself move a PickupRequest to received_at_store or reassign
 * its rider — confirming does (PickupHandoverController.confirm for a
 * store target, RiderPickupHandoverController.confirm for a rider
 * target), same as RiderCashHandover deferring all balance effects to its
 * own confirm step.
 */
@model({
  settings: {
    postgresql: {table: 'pickup_handover', schema: 'public'},
    indexes: {
      uniquePickupHandoverNumber: {keys: ['handoverNumber'], options: {unique: true}},
    },
  },
})
export class PickupHandover extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // 'PH-{riderCode}-{ddMM}-{seq}' — server-generated, human-readable.
  @property({type: 'string', required: true})
  handoverNumber: string;

  // 6-digit numeric, shown as text and encoded into a QR — the single
  // identifier both scan-confirm and manual-entry-confirm resolve by.
  // Unique only among currently-PENDING rows (enforced in the controller,
  // not a DB constraint) — free to be reused once a batch is confirmed.
  @property({type: 'string', required: true})
  handoverCode: string;

  @property({
    type: 'string',
    default: PickupHandoverStatus.PENDING,
    jsonSchema: {enum: Object.values(PickupHandoverStatus)},
  })
  status?: PickupHandoverStatus;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderId: string;

  @property({type: 'string', required: true})
  riderName: string;

  // Denormalized — same reasoning as RiderCashHandover.riderCode.
  @property({type: 'string', required: true})
  riderCode: string;

  // Denormalized count of linked PickupHandoverItem rows.
  @property({type: 'number', default: 0})
  itemCount?: number;

  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(PickupHandoverTargetType)},
  })
  handoverToType?: PickupHandoverTargetType;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  handoverToStoreId?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  handoverToRiderId?: string;

  // Denormalized display snapshot — the target store's name, or the
  // target rider's full name.
  @property({type: 'string'})
  handoverToName?: string;

  @property({type: 'date', required: true})
  submittedAt: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  submittedBy: string;

  @property({type: 'date'})
  confirmedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  confirmedBy?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<PickupHandover>) {
    super(data);
  }
}

export interface PickupHandoverRelations {}
export type PickupHandoverWithRelations = PickupHandover & PickupHandoverRelations;
