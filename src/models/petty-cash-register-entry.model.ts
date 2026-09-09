import {Entity, model, property} from '@loopback/repository';
import {PettyCashStatus} from './petty-cash-status.enum';

/**
 * One staff-logged petty cash expense at a store. Starts PENDING and only
 * ever debits the store's balance once resolved APPROVED (see
 * PettyCashService.computeBalance) — a REJECTED or still-PENDING entry
 * never touches it. Approval can be partial: approvedAmount may be less
 * than amount, with the shortfall recorded as disapprovedAmt.
 *
 * Soft-deletable (isDeleted), but only while still PENDING — the
 * controller enforces that, not the model — since an already-resolved
 * entry has already moved money and deleting it would silently orphan
 * that balance effect.
 */
@model({settings: {postgresql: {table: 'petty_cash_register_entry', schema: 'public'}}})
export class PettyCashRegisterEntry extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  storeId: string;

  @property({type: 'string'})
  storeCode?: string;

  @property({type: 'string'})
  storeName?: string;

  // Who spent it — resolved server-side from the caller, not client-supplied.
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  userId: string;

  @property({type: 'string'})
  userName?: string;

  @property({type: 'date', required: true})
  expenseDate: Date;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  // Only 'Cash' today (matches the frontend's single radio option) — kept
  // as a plain string, not an enum, since nothing else validates against it.
  @property({type: 'string', default: 'Cash'})
  method?: string;

  // Expense category — one of PETTY_EXPENSE_DESCRIPTIONS on the frontend.
  // Plain string, not a master-data table: that list is a fixed frontend
  // constant today, not something admins configure.
  @property({type: 'string', required: true})
  description: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  remarks: string;

  @property({
    type: 'string',
    default: PettyCashStatus.PENDING,
    jsonSchema: {enum: Object.values(PettyCashStatus)},
  })
  status?: PettyCashStatus;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  approvedAmount?: number;

  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  disapprovedAmt?: number;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  resolvedRemark?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  resolvedBy?: string;

  @property({type: 'string'})
  resolvedByName?: string;

  @property({type: 'date'})
  resolvedAt?: Date;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<PettyCashRegisterEntry>) {
    super(data);
  }
}

export interface PettyCashRegisterEntryRelations {}
export type PettyCashRegisterEntryWithRelations = PettyCashRegisterEntry & PettyCashRegisterEntryRelations;
