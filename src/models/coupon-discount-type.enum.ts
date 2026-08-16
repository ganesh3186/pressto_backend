// Matches Order.discountType's existing string values exactly (see
// applyCustomerDiscount() in order.service.ts) so a coupon's discount can
// be written straight into Order without any translation step.
export enum CouponDiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
}
