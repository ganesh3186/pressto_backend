import {Entity, model, property} from '@loopback/repository';

export enum SalesReturnStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@model({
  settings: {
    postgresql: {table: 'sales_return', schema: 'public'},
    indexes: {
      uniqueCreditNoteNumber: {keys: ['creditNoteNumber'], options: {unique: true}},
    },
  },
})
export class SalesReturn extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  invoiceId?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  customerId: string;

  // Unique credit note number: CN-YYYYMM-00001
  @property({type: 'string'})
  creditNoteNumber?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  reason?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  // Snapshot of returned items
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  returnedItems?: object[];

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  creditAmount?: number;

  @property({
    type: 'string',
    default: SalesReturnStatus.PENDING,
    jsonSchema: {enum: Object.values(SalesReturnStatus)},
  })
  status?: SalesReturnStatus;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  requestedBy?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  resolvedBy?: string;

  @property({type: 'date'})
  resolvedAt?: Date;

  // How credit is applied: wallet | adjustment | refund
  @property({type: 'string'})
  creditAppliedAs?: string;

  // Payout method picked up front, when the return is created — 'wallet' |
  // 'bank_account' | 'cash'. Only ever used if approve() finds a refund is
  // actually due; the refund then pays out immediately on approval using
  // this choice, no separate payout approval.
  @property({type: 'string', default: 'wallet'})
  refundMethod?: string;

  // Only populated when refundMethod === 'bank_account'.
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  bankDetails?: object;

  // The actual amount refunded at approval time (0 if the credit was fully
  // absorbed into a lower balance due) — stored so later reads (the Finance
  // Approvals list) show what really happened instead of recomputing a
  // live preview against the order's now-already-adjusted totals.
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  refundAmount?: number;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<SalesReturn>) {
    super(data);
  }
}

export interface SalesReturnRelations {}
export type SalesReturnWithRelations = SalesReturn & SalesReturnRelations;
