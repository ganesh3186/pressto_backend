import {Entity, model, property} from '@loopback/repository';
import {RiderCashHandoverStatus} from './rider-cash-handover-status.enum';
import {RiderCashHandoverTargetType} from './rider-cash-handover-target-type.enum';

/**
 * Batch header for cash a rider collected at the door and is handing over
 * — the rider app's "Handover Cash" screen selects several pending
 * PaymentTransaction rows, picks who it's going to (a store, or another
 * rider — see RiderCashHandoverTargetType), and submits them as one of
 * these. Mirrors Transfer's header/line-item split exactly.
 *
 * Does NOT move any money or re-touch order balances — those were already
 * settled the instant addPayment() ran at collection time (see
 * OrderService.addPayment's riderId param). This is bookkeeping only:
 * where is the physical cash right now, and has the recipient confirmed
 * receiving it — store staff confirm a STORE-targeted handover via the
 * admin panel (RiderCashHandoverController.confirm); the target rider
 * confirms a RIDER-targeted one themselves, via the rider app, same
 * accountability rule as a transfer/pickup receive.
 */
@model({
  settings: {
    postgresql: {table: 'rider_cash_handover', schema: 'public'},
    indexes: {
      uniqueHandoverNumber: {keys: ['handoverNumber'], options: {unique: true}},
    },
  },
})
export class RiderCashHandover extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // 'CH-{riderCode}-{ddMM}-{seq}' — server-generated, human-readable.
  @property({type: 'string', required: true})
  handoverNumber: string;

  @property({
    type: 'string',
    default: RiderCashHandoverStatus.PENDING,
    jsonSchema: {enum: Object.values(RiderCashHandoverStatus)},
  })
  status?: RiderCashHandoverStatus;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderId: string;

  @property({type: 'string', required: true})
  riderName: string;

  // Denormalized — TabCashPending (admin panel) needs this column directly,
  // not via a rider join.
  @property({type: 'string', required: true})
  riderCode: string;

  // Denormalized sum of the linked RiderCashHandoverItem amounts.
  @property({type: 'number', required: true})
  totalAmount: number;

  @property({type: 'number', default: 0})
  itemCount?: number;

  // Who this batch is going to — resolves to exactly one of the two ids
  // below, validated at submission (RiderDeliveryController.submitHandover).
  // Optional at the type level only so adding this column doesn't require
  // a NOT NULL backfill migration for rows that predate this feature —
  // the create() endpoint always sets it, so in practice every new row
  // has one; a null on an old row reads as "store", same as before this
  // field existed (see RiderCashHandoverController.confirm's guard).
  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(RiderCashHandoverTargetType)},
  })
  handoverToType?: RiderCashHandoverTargetType;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  handoverToStoreId?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  handoverToRiderId?: string;

  // Denormalized display snapshot — the target store's name, or the
  // target rider's full name, whichever applies. Same convention as
  // riderName above, and same "optional at the type level only" reasoning
  // as handoverToType.
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

  constructor(data?: Partial<RiderCashHandover>) {
    super(data);
  }
}

export interface RiderCashHandoverRelations {}
export type RiderCashHandoverWithRelations = RiderCashHandover & RiderCashHandoverRelations;
