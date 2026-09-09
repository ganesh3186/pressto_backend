import {Entity, model, property} from '@loopback/repository';

/**
 * One row per PaymentTransaction included in a RiderCashHandover batch —
 * normalized join, mirrors TransferItem's role under Transfer.
 */
@model({
  settings: {
    postgresql: {table: 'rider_cash_handover_item', schema: 'public'},
    indexes: {
      paymentTransactionLookup: {keys: ['paymentTransactionId']},
    },
  },
})
export class RiderCashHandoverItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderCashHandoverId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  paymentTransactionId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true})
  orderNumber: string;

  @property({type: 'string', required: true})
  customerName: string;

  // Denormalized snapshot of PaymentTransaction.amount at submission time.
  @property({type: 'number', required: true})
  amount: number;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<RiderCashHandoverItem>) {
    super(data);
  }
}

export interface RiderCashHandoverItemRelations {}
export type RiderCashHandoverItemWithRelations = RiderCashHandoverItem & RiderCashHandoverItemRelations;
