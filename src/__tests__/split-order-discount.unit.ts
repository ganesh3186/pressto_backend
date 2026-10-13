import {expect} from '@loopback/testlab';
import {calculateSplitDiscounts} from '../services/split-order-discount';

describe('split order discount', () => {
  it('recalculates a percentage discount after the child delivery price changes', () => {
    expect(
      calculateSplitDiscounts(499.2, 49.92, 499.2, 460.8, 'percentage'),
    ).to.deepEqual({originalShare: 49.92, childDiscount: 46.08});
  });

  it('keeps the original allocation for fixed and coupon discounts', () => {
    expect(calculateSplitDiscounts(1000, 100, 500, 400, 'fixed')).to.deepEqual({
      originalShare: 50,
      childDiscount: 50,
    });
    expect(
      calculateSplitDiscounts(1000, 100, 500, 400, 'percentage', true),
    ).to.deepEqual({originalShare: 50, childDiscount: 50});
  });
});
