import {Entity, model, property} from '@loopback/repository';

// Join table letting one Invoice cover several Orders — used exclusively by
// On Account consolidated billing (see OnAccountBillingController). Every
// *normal* invoice still has exactly one row here mirroring its own
// Invoice.orderId; a consolidated invoice has one row per order it bills.
// orderTotal is a snapshot of that order's contribution at generation time —
// the invoice's own totals are the sum of these, not recomputed later.
@model({
  settings: {
    postgresql: {
      table: 'invoice_order_link',
      schema: 'public',
    },
    indexes: {
      uniqueInvoiceOrderLink: {
        keys: {invoiceId: 1, orderId: 1},
        options: {unique: true},
      },
    },
  },
})
export class InvoiceOrderLink extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  invoiceId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  orderId: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  orderTotal: number;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<InvoiceOrderLink>) {
    super(data);
  }
}

export interface InvoiceOrderLinkRelations {}

export type InvoiceOrderLinkWithRelations = InvoiceOrderLink & InvoiceOrderLinkRelations;
