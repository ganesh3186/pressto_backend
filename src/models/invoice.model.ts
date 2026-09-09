import {Entity, model, property} from '@loopback/repository';

export enum InvoiceStatus {
  DRAFT = 'draft',
  ISSUED = 'issued',
}

@model({
  settings: {
    postgresql: {table: 'invoice', schema: 'public'},
    indexes: {
      uniqueInvoiceNumber: {keys: ['invoiceNumber'], options: {unique: true}},
    },
  },
})
export class Invoice extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  // Challan this invoice was converted from
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  challanId?: string;

  // INV-YYYYMM-00001
  @property({type: 'string', required: true})
  invoiceNumber: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  generatedBy: string;

  // Full item snapshot at invoice time (may differ from challan due to upgrades/returns)
  @property({type: 'array', itemType: 'object', postgresql: {dataType: 'jsonb'}})
  items?: object[];

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  subtotal?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  discount?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  deliveryCharge?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  cgst?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  sgst?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  totalAmount?: number;

  // Amount already received against this order (advances, partial payments)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  amountReceived?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  balanceDue?: number;

  @property({
    type: 'string',
    default: InvoiceStatus.DRAFT,
    jsonSchema: {enum: Object.values(InvoiceStatus)},
  })
  status?: InvoiceStatus;

  // On Account consolidated billing: this invoice covers several orders, not
  // just `orderId` (which is kept as a representative order so every existing
  // single-order read path — printing, GET /orders/{id}/invoice — still
  // resolves something sensible). The full set is in InvoiceOrderLink.
  @property({type: 'boolean', default: false})
  isConsolidated?: boolean;

  @property({type: 'boolean', default: false})
  isPrinted?: boolean;

  @property({type: 'date'})
  printedAt?: Date;

  // On Account only — generatedAt + the customer's effective invoice span at
  // the time this was created (see customer-billing.controller.ts's
  // generateOnAccountInvoice). Null for a regular per-order invoice.
  @property({type: 'date'})
  dueDate?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<Invoice>) {
    super(data);
  }
}

export interface InvoiceRelations {}
export type InvoiceWithRelations = Invoice & InvoiceRelations;
