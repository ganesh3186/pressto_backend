// What a GatewayPaymentLink is paying for — decides which service
// RazorpayService.applyPayment() dispatches to once the payment is
// confirmed (verifyAndApplyPayment(), or handlePaymentCaptured() as a
// fallback).
export enum GatewayPaymentReferenceType {
  ORDER_PAYMENT = 'order_payment',
  WALLET_TOPUP = 'wallet_topup',
  SECURITY_DEPOSIT_TOPUP = 'security_deposit_topup',
  // Create Order (POS) with PGLink selected: the order isn't created until
  // payment is confirmed, so there's no order id yet to attach to — only a
  // client-generated correlation id (referenceId), not a real row. Nothing
  // to apply here; the admin panel itself creates the order right after
  // confirmation, passing the verified Razorpay payment id through as the
  // order's own trusted payment reference (the same path cash/UPI/card
  // already use). See RazorpayService.applyPayment().
  NEW_ORDER_PAYMENT = 'new_order_payment',
}
