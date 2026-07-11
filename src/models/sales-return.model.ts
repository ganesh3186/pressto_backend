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
