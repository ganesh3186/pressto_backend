import {Entity, model, property} from '@loopback/repository';
import {GatewayPaymentLinkStatus} from './gateway-payment-link-status.enum';
import {GatewayPaymentReferenceType} from './gateway-payment-reference-type.enum';

/**
 * One row per Razorpay payment created from any of the "PGLink" entry
 * points (order payment, wallet top-up, security deposit top-up — see
 * GatewayPaymentReferenceType). Two shapes, by which fields are set:
 *
 * - razorpayOrderId set, razorpayPaymentLinkId/shortUrl empty: the
 *   original inline Razorpay Checkout popup (Orders API) — still used by
 *   Wallet/Security Deposit top-up (hidden from the admin panel for now,
 *   code kept). Flipped to `paid` by RazorpayService.verifyAndApply-
 *   Payment() (the popup's own `handler` callback, signature-verified)
 *   or handlePaymentCaptured() (the `payment.captured` webhook, a
 *   fallback for when the browser never gets to call the handler).
 * - razorpayPaymentLinkId/shortUrl set, razorpayOrderId empty: a real
 *   shareable Razorpay Payment Link (Payment Links API) — order payment
 *   only, shared to the customer over WhatsApp instead of opened on
 *   staff's own screen. The customer pays it on their own device,
 *   whenever; flipped to `paid` by handlePaymentLinkPaid() (the
 *   `payment_link.paid` webhook — the only confirmation path here, there
 *   is no popup/handler callback since staff never see Razorpay's UI).
 *
 * Either flow applies the underlying payment via whichever existing
 * service already owns that reference type (OrderService.addPayment,
 * WalletService.confirmRecharge, SecurityDepositService.confirmTopup)
 * and is idempotent against a second confirmation path also firing.
 */
@model({
  settings: {
    postgresql: {table: 'gateway_payment_link', schema: 'public'},
  },
})
export class GatewayPaymentLink extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string'})
  razorpayOrderId?: string;

  // Payment Links API fields — see the class doc above for which shape a
  // given row uses.
  @property({type: 'string'})
  razorpayPaymentLinkId?: string;

  @property({type: 'string'})
  shortUrl?: string;

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
