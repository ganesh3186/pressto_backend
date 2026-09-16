import {Entity, model, property} from '@loopback/repository';
import {GatewayPaymentLinkStatus} from './gateway-payment-link-status.enum';
import {GatewayPaymentReferenceType} from './gateway-payment-reference-type.enum';

/**
 * One row per Razorpay order created from any of the "PGLink" entry
 * points (order payment, wallet top-up, security deposit top-up — see
 * GatewayPaymentReferenceType), backing an inline Razorpay Checkout
 * popup (not a shareable payment link — no separate URL/short_url is
 * ever generated). Created in `created` status when the order is
 * created; flipped to `paid` either by RazorpayService.verifyAndApply-
 * Payment() (the frontend's Checkout `handler` callback, signature-
 * verified) or by RazorpayService.handlePaymentCaptured() (the
 * signature-verified `payment.captured` webhook, a fallback for when the
 * browser never gets to call the handler — e.g. a UPI intent completes
 * after the popup was dismissed). Either path applies the underlying
 * payment via whichever existing service already owns that flow
 * (OrderService.addPayment, WalletService.confirmRecharge,
 * SecurityDepositService.confirmTopup) and is idempotent against the
 * other one also firing.
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
  razorpayOrderId: string;

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
