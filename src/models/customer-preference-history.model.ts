import {Entity, model, property} from '@loopback/repository';

// Append-only audit trail — one row per individual CustomerPreference
// field change, mirroring OrderStatusHistory's shape rather than a
// generic before/after-blob log. oldValue/newValue are always strings —
// booleans and string[] values are JSON.stringify'd at write time, since
// every CustomerPreference field is scalar-ish and this keeps the log
// trivially diffable without a jsonb column.
@model({
  settings: {postgresql: {table: 'customer_preference_history', schema: 'public'}},
})
export class CustomerPreferenceHistory extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  customerId: string;

  @property({type: 'string', required: true})
  settingKey: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  oldValue?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  newValue?: string;

  @property({type: 'date', defaultFn: 'now'})
  changedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  changedBy?: string;

  constructor(data?: Partial<CustomerPreferenceHistory>) {
    super(data);
  }
}

export interface CustomerPreferenceHistoryRelations {}

export type CustomerPreferenceHistoryWithRelations = CustomerPreferenceHistory & CustomerPreferenceHistoryRelations;
