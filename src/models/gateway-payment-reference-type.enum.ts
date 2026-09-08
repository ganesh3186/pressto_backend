// What a GatewayPaymentLink is paying for — decides which service
// RazorpayService.handlePaymentLinkPaid() dispatches to once the webhook
// confirms payment.
export enum GatewayPaymentReferenceType {
  ORDER_PAYMENT = 'order_payment',
  WALLET_TOPUP = 'wallet_topup',
  SECURITY_DEPOSIT_TOPUP = 'security_deposit_topup',
}
