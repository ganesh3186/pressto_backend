import {Entity, model, property} from '@loopback/repository';

/**
 * A finance top-up into one store's petty cash float. Permanent once
 * created — no soft-delete, no edit path (matches TransferItem/
 * OrderStatusHistory's "write-once, read-whole-record-back" convention for
 * an audit-style ledger row).
 */
@model({settings: {postgresql: {table: 'petty_cash_finance_entry', schema: 'public'}}})
export class PettyCashFinanceEntry extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  storeId: string;

  // Denormalized snapshot for display — same convention as Transfer's
  // fromStoreName/toStoreName (batch-resolve at read time, not @belongsTo).
  @property({type: 'string'})
  storeCode?: string;

  @property({type: 'string'})
  storeName?: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  remarks: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  createdBy: string;

  @property({type: 'string'})
  createdByName?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<PettyCashFinanceEntry>) {
    super(data);
  }
}

export interface PettyCashFinanceEntryRelations {}
export type PettyCashFinanceEntryWithRelations = PettyCashFinanceEntry & PettyCashFinanceEntryRelations;
