import {Entity, model, property} from '@loopback/repository';
import {PaymentMode} from './payment-mode.enum';
import {PaymentRequestStatus} from './payment-request-status.enum';

@model({
  settings: {
    postgresql: {
      table: 'wallet_recharge_request',
      schema: 'public',
    },
  },
})
export class WalletRechargeRequest extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  customerId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  walletId: string;

  @property({type: 'string', required: true})
  requestNumber: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  amount: number;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(PaymentMode)},
  })
  paymentMode: PaymentMode;

  @property({
    type: 'string',
    default: PaymentRequestStatus.PENDING,
    jsonSchema: {enum: Object.values(PaymentRequestStatus)},
  })
  status?: PaymentRequestStatus;

  // Populated by payment gateway on callback
  @property({type: 'string'})
  paymentReferenceId?: string;

  // Raw gateway response stored as JSON string for audit
  @property({type: 'string', postgresql: {dataType: 'text'}})
  gatewayResponse?: string;

  @property({type: 'string'})
  remarks?: string;

  // Set when an admin performs the recharge on behalf of the customer
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  performedBy?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<WalletRechargeRequest>) {
    super(data);
  }
}

export interface WalletRechargeRequestRelations {}

export type WalletRechargeRequestWithRelations = WalletRechargeRequest &
  WalletRechargeRequestRelations;
