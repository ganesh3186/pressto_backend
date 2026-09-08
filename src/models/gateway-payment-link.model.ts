import {Entity, model, property} from '@loopback/repository';
import {GatewayPaymentLinkStatus} from './gateway-payment-link-status.enum';
import {GatewayPaymentReferenceType} from './gateway-payment-reference-type.enum';

/**
 * One row per Razorpay payment link created from any of the "PGLink"
 * entry points (order payment, wallet top-up, security deposit top-up —
 * see GatewayPaymentReferenceType). Created in `created` status when the
 * link is generated; RazorpayService.handlePaymentLinkPaid() (called from
 * the signature-verified webhook, never from the client) flips it to
 * `paid` and applies the underlying payment via whichever existing
 * service already owns that flow (OrderService.addPayment,
 * WalletService.confirmRecharge, SecurityDepositService.confirmTopup).
 */
@model({
  settings: {
    postgresql: {table: 'gateway_payment_link', schema: 'public'},
  },
})
export class GatewayPaymentLink extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true})
  razorpayLinkId: string;

  @property({type: 'string', required: true})
  razorpayShortUrl: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({
    type: 'string',
    default: GatewayPaymentLinkStatus.CREATED,
    jsonSchema: {enum: Object.values(GatewayPaymentLinkStatus)},
  })
  status?: GatewayPaymentLinkStatus;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(GatewayPaymentReferenceType)},
  })
  referenceType: GatewayPaymentReferenceType;

  // The order id / WalletRechargeRequest id / SecurityDepositTopupRequest
  // id this link is paying for, depending on referenceType.
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  referenceId: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  createdBy?: string;

  @property({type: 'date'})
  paidAt?: Date;

  // Full webhook payload, for audit — also where we record an application
  // failure (money arrived at Razorpay but applying it to the order/
  // wallet/deposit threw) so it's never silently lost, only ever visible
  // for manual reconciliation.
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  rawWebhookPayload?: object;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  applicationError?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GatewayPaymentLink>) {
    super(data);
  }
}

export interface GatewayPaymentLinkRelations {}
export type GatewayPaymentLinkWithRelations = GatewayPaymentLink & GatewayPaymentLinkRelations;
