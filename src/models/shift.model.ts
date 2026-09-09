import {Entity, model, property} from '@loopback/repository';
import {ShiftStatus} from './shift-status.enum';

/**
 * A cashier's POS shift at one store — opening cash/voucher reconciliation,
 * then a much larger closing reconciliation. `opening`/`closing` are jsonb
 * form snapshots (write-once, read-whole-record, never queried into
 * individual sub-fields), matching SalesReturn.returnedItems' convention.
 * Their shapes mirror the frontend's createEmptyOpeningBalances()/
 * createDefaultClosingForm() (src/utils/shift-module.js) field-for-field.
 *
 * Scoped (userId, storeId) — one open shift per cashier per store,
 * enforced in the controller (no DB constraint precedent for a
 * status-conditional unique index elsewhere in this codebase, matching
 * RiderPincodeMapping's same posture for "one active mapping per pincode").
 */
@model({
  settings: {
    postgresql: {table: 'shift', schema: 'public'},
    indexes: {
      uniqueStoreOpeningNo: {keys: ['storeId', 'openingNo'], options: {unique: true}},
    },
  },
})
export class Shift extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // Per-store sequential — count({storeId})+1 at open time. closureNo is
  // set equal to this at close, matching the frontend's existing behavior
  // (openingNo/closureNo are literally the same number reused, not two
  // separate sequences).
  @property({type: 'number', required: true})
  openingNo: number;

  @property({type: 'number'})
  closureNo?: number;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  storeId: string;

  @property({type: 'string'})
  storeCode?: string;

  @property({type: 'string'})
  storeName?: string;

  // The cashier who opened (and, per this pass, the only one who may
  // close) this shift.
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  userId: string;

  @property({type: 'string'})
  userName?: string;

  @property({
    type: 'string',
    default: ShiftStatus.OPEN,
    jsonSchema: {enum: Object.values(ShiftStatus)},
  })
  status?: ShiftStatus;

  @property({type: 'date', required: true})
  openedAt: Date;

  @property({type: 'date'})
  closedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  openingUserId?: string;

  @property({type: 'string'})
  openingUserName?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  closingUserId?: string;

  @property({type: 'string'})
  closingUserName?: string;

  // {cashInTill, banking, pettyCash, prepaidVouchers}, each {supposed, actual, difference}, + remarks
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  opening?: object;

  // Full closing reconciliation form — see createDefaultClosingForm() in
  // shift-module.js for the exact shape. Null until closed.
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  closing?: object;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<Shift>) {
    super(data);
  }
}

export interface ShiftRelations {}
export type ShiftWithRelations = Shift & ShiftRelations;
