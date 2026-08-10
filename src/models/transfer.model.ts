import {Entity, model, property} from '@loopback/repository';
import {TransferStatus} from './transfer-status.enum';

/**
 * Header record for one bag's worth of garments sent between stores.
 * Atomic create-and-send: there is no draft state — a Transfer is always
 * created already SENT, matching the frontend's single "Create transfer"
 * action (scan bag, scan items, done).
 *
 * fromStoreId/toStoreId/bagId are plain uuid properties, not @belongsTo —
 * matches SalesReturn/ApprovalRequest's convention for permanent,
 * audit-style records (batch-resolve display names at read time), not
 * PickupRequest's @belongsTo style. Two store references plus bespoke
 * list/detail enrichment either way makes belongsTo's main benefit (auto
 * `include`) moot here.
 */
@model({
  settings: {
    postgresql: {table: 'transfer', schema: 'public'},
    indexes: {
      uniqueTransitId: {keys: ['transitId'], options: {unique: true}},
      uniqueTransferOrderNumber: {keys: ['transferOrderNumber'], options: {unique: true}},
    },
  },
})
export class Transfer extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // 'TR-{fromCode}-{toCode}-{ddMM}-{seq}' — server-generated, human-readable.
  @property({type: 'string', required: true})
  transitId: string;

  // 'TO-{yyyyMM}-{00001}' — same sequence-number pattern as SalesReturn's
  // credit-note numbering (sales-return.controller.ts's create()).
  @property({type: 'string', required: true})
  transferOrderNumber: string;

  @property({
    type: 'string',
    default: TransferStatus.SENT,
    jsonSchema: {enum: Object.values(TransferStatus)},
  })
  status?: TransferStatus;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  fromStoreId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  toStoreId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  bagId: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  reason?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'date', required: true})
  sentAt: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  sentBy: string;

  @property({type: 'date'})
  receivedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  receivedBy?: string;

  // Denormalized — manifest size, avoids a count() on every list row.
  @property({type: 'number', default: 0})
  itemCount?: number;

  // Denormalized — missing+extra count, set at receive time.
  @property({type: 'number', default: 0})
  discrepancyCount?: number;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<Transfer>) {
    super(data);
  }
}

export interface TransferRelations {}
export type TransferWithRelations = Transfer & TransferRelations;
