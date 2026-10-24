import {CouponDiscountType, CouponMinRequirementType} from '../models';

export type CouponImportRow = Record<string, unknown>;

export function parseCouponImportRow(row: CouponImportRow): {
  coupon: Record<string, unknown>;
  errors: string[];
} {
  const errors: string[] = [];
  const value = (key: string) => String(row[key] ?? '').trim();
  const coupon: Record<string, unknown> = {
    code: value('code').toUpperCase(),
    name: value('name'),
    description: value('description'),
    discountType: value('discountType'),
    startDate: value('startDate'),
    endDate: value('endDate'),
  };

  if (!coupon.code)
    errors.push('code is required: enter a unique coupon code in column A');
  if (!coupon.name) errors.push('name is required');
  if (
    ![
      CouponDiscountType.PERCENTAGE,
      CouponDiscountType.FIXED,
      CouponDiscountType.CHEAPEST_ITEM_FREE,
    ].includes(coupon.discountType as CouponDiscountType)
  ) {
    errors.push(
      'discountType must be percentage, fixed, or cheapest_item_free',
    );
  }

  const number = (
    key: string,
    required = false,
    integer = false,
    minimum = 0,
  ) => {
    const raw = value(key);
    if (!raw) {
      if (required) errors.push(`${key} is required`);
      return;
    }
    const parsed = Number(raw);
    if (
      !Number.isFinite(parsed) ||
      parsed < minimum ||
      (integer && !Number.isInteger(parsed))
    ) {
      errors.push(
        `${key} must be ${integer ? 'a whole number' : 'a number'} of at least ${minimum}`,
      );
    } else coupon[key] = parsed;
  };

  const discountType = coupon.discountType;
  if (discountType === CouponDiscountType.CHEAPEST_ITEM_FREE) {
    coupon.discountValue = 0;
    number('minQualifyingItems', true, true, 2);
    if (value('discountValue') && Number(value('discountValue')) !== 0)
      errors.push('discountValue must be blank or 0 for cheapest_item_free');
  } else {
    number('discountValue', true, false, 0.01);
    if (
      discountType === CouponDiscountType.PERCENTAGE &&
      Number(coupon.discountValue) > 100
    )
      errors.push('discountValue cannot exceed 100%');
    if (value('minQualifyingItems'))
      errors.push('minQualifyingItems applies only to cheapest_item_free');
  }
  number('maxDiscountAmount', false, false, 0.01);
  if (
    value('maxDiscountAmount') &&
    discountType !== CouponDiscountType.PERCENTAGE
  )
    errors.push('maxDiscountAmount applies only to percentage');

  const minType = value('minRequirementType');
  if (minType) {
    if (
      !Object.values(CouponMinRequirementType).includes(
        minType as CouponMinRequirementType,
      )
    )
      errors.push('minRequirementType must be amount or quantity');
    else coupon.minRequirementType = minType;
    number(
      'minRequirementValue',
      true,
      minType === CouponMinRequirementType.QUANTITY,
      0.01,
    );
  } else if (value('minRequirementValue'))
    errors.push('minRequirementType is required with minRequirementValue');

  number('newCustomerOrderLimit', false, true, 1);
  number('maxUsesPerCustomer', false, true, 1);
  number('maxUsesTotal', false, true, 1);

  for (const key of ['isReferralCode', 'isActive']) {
    const raw = value(key).toLowerCase();
    if (raw && raw !== 'true' && raw !== 'false')
      errors.push(`${key} must be true or false`);
    else coupon[key] = raw ? raw === 'true' : key === 'isActive';
  }
  if (coupon.isReferralCode && coupon.newCustomerOrderLimit)
    errors.push('isReferralCode and newCustomerOrderLimit cannot both be set');

  for (const key of ['startDate', 'endDate']) {
    const raw = value(key);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ||
      new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw
    ) {
      errors.push(`${key} must be a valid YYYY-MM-DD date`);
    }
  }
  if (coupon.startDate && coupon.endDate && coupon.startDate > coupon.endDate)
    errors.push('endDate must be on or after startDate');
  return {coupon, errors};
}
