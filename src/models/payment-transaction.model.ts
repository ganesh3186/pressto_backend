import {Entity, model, property} from '@loopback/repository';
import {PaymentMode} from './payment-mode.enum';

@model({
  settings: {postgresql: {table: 'payment_transaction', schema: 'public'}},
})
export class PaymentTransaction extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(PaymentMode)},
  })
  paymentMode: PaymentMode;

  // 'payment' (money in) | 'refund' (money returned to customer). Refunds are
  // recorded for the audit trail but are NOT counted toward amount collected.
  @property({type: 'string', default: 'payment'})
  transactionType?: string;

  @property({type: 'string'})
  transactionReference?: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'date', defaultFn: 'now'})
  paymentDate?: Date;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  gatewayResponse?: string;

  // Set only when a rider collected this payment at the customer's door
  // (OrderService.addPayment's riderId param) — undefined for every other
  // payment in the system (POS counter, online, etc.).
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  riderId?: string;

  // 'with_rider' | 'submitted' | 'handed_over' — only meaningful when
  // riderId is set, and only for CASH (wallet/UPI/card settle instantly,
  // nothing physical to hand over). Bookkeeping only: never re-touches
  // the order balance, which was already settled the instant this
  // transaction was created.
  @property({type: 'string'})
  riderHandoverStatus?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<PaymentTransaction>) {
    super(data);
  }
}

export interface PaymentTransactionRelations {}
export type PaymentTransactionWithRelations = PaymentTransaction & PaymentTransactionRelations;
