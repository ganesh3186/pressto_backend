import {Entity, model, property} from '@loopback/repository';
import {PaymentMode} from './payment-mode.enum';
import {PaymentRequestStatus} from './payment-request-status.enum';

@model({
  settings: {
    postgresql: {
      table: 'security_deposit_topup_request',
      schema: 'public',
    },
  },
})
export class SecurityDepositTopupRequest extends Entity {
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
  securityDepositId: string;

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

  // Set when an admin performs the top-up on behalf of the customer
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  performedBy?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<SecurityDepositTopupRequest>) {
    super(data);
  }
}

export interface SecurityDepositTopupRequestRelations {}

export type SecurityDepositTopupRequestWithRelations =
  SecurityDepositTopupRequest & SecurityDepositTopupRequestRelations;
