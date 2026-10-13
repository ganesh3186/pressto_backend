export function calculateSplitDiscounts(
  parentSubtotal: number,
  parentDiscount: number,
  originalChildSubtotal: number,
  childSubtotal: number,
  discountType?: string,
  hasCoupon = false,
): {originalShare: number; childDiscount: number} {
  const originalShare = parseFloat(
    ((parentDiscount * originalChildSubtotal) / (parentSubtotal || 1)).toFixed(
      2,
    ),
  );
  const childDiscount =
    discountType === 'percentage' && !hasCoupon
      ? parseFloat(
          ((parentDiscount * childSubtotal) / (parentSubtotal || 1)).toFixed(2),
        )
      : originalShare;
  return {originalShare, childDiscount};
}
