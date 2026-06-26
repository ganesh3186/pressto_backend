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

  @property({type: 'string'})
  transactionReference?: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'date', defaultFn: 'now'})
  paymentDate?: Date;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  gatewayResponse?: string;

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
