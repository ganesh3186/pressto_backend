// Which kind of minimum a coupon requires before it can be applied at
// all — gates usability (CouponService.evaluate()), separate from
// discountType's minQualifyingItems above (which only ever shapes how
// large the cheapest_item_free discount is, never whether any other
// coupon type is usable). At most one of AMOUNT/QUANTITY applies per
// coupon — the admin panel's create/edit form only lets one be
// configured at a time.
export enum CouponMinRequirementType {
  AMOUNT = 'amount',
  QUANTITY = 'quantity',
}
