// PERCENTAGE/FIXED match Order.discountType's existing string values
// exactly (see applyCustomerDiscount() in order.service.ts) so a coupon's
// discount can be written straight into Order without any translation
// step. CHEAPEST_ITEM_FREE has no Order.discountType equivalent — it's
// resolved to a plain rupee discountAmount by CouponService.evaluate()
// before it ever reaches Order, same as the other two.
export enum CouponDiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
  CHEAPEST_ITEM_FREE = 'cheapest_item_free',
  // Auto-applied at pricing time (OrderService.resolvePricing()), never
  // selected or redeemed — see CouponPriceOverride. discountValue is
  // meaningless for this type (kept 0 by convention); the real per-item
  // prices live in the CouponPriceOverride rows for this coupon.
  PRICE_OVERRIDE = 'price_override',
}
