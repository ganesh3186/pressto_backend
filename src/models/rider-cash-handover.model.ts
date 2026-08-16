import {Entity, model, property} from '@loopback/repository';
import {RiderCashHandoverStatus} from './rider-cash-handover-status.enum';

/**
 * Batch header for cash a rider collected at the door and is handing back
 * to the store — the rider app's "Handover Cash" screen selects several
 * pending PaymentTransaction rows and submits them as one of these.
 * Mirrors Transfer's header/line-item split exactly.
 *
 * Does NOT move any money or re-touch order balances — those were already
 * settled the instant addPayment() ran at collection time (see
 * OrderService.addPayment's riderId param). This is bookkeeping only:
 * where is the physical cash right now, and has the store confirmed
 * receiving it.
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
