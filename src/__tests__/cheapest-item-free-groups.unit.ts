import {expect} from '@loopback/testlab';
import {CouponDiscountType} from '../models';
import {cheapestUnitsTotal, CouponService} from '../services/coupon.service';

const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();

/** `count` single-unit lines priced 100, 110, 120, ... */
function lines(count: number) {
  return Array.from({length: count}, (_, i) => ({
    itemId: `item-${i}`,
    serviceId: 'clean',
    quantity: 1,
    totalPrice: 100 + i * 10,
  }));
}

function serviceFor(minQualifyingItems: number | undefined) {
  const coupon = {
    id: 'coupon-1',
    code: '3FOR2',
    name: 'Get 3, Pay 2',
    discountType: CouponDiscountType.CHEAPEST_ITEM_FREE,
    discountValue: 0,
    minQualifyingItems,
    startDate: past,
    endDate: future,
    isActive: true,
    isDeleted: false,
  };
  return Object.assign(Object.create(CouponService.prototype), {
    couponRepo: {findOne: async () => coupon},
    // Open to every customer: no label or individual targeting.
    couponCustomerRepo: {count: async () => ({count: 0})},
  }) as CouponService;
}

async function discountFor(minQualifyingItems: number | undefined, items: object[]) {
  const result = await serviceFor(minQualifyingItems).evaluate({
    couponCode: '3FOR2',
    customerId: 'customer-1',
    storeId: 'store-1',
    items,
  } as never);
  return result;
}

describe('cheapest item free, one per group of N', () => {
  it('adds up the cheapest units across lines, by quantity', () => {
    const order = [
      {quantity: 2, totalPrice: 300}, // 150 each
      {quantity: 3, totalPrice: 180}, // 60 each
      {quantity: 1, totalPrice: 90},
    ];
    expect(cheapestUnitsTotal(order, 1)).to.equal(60);
    expect(cheapestUnitsTotal(order, 4)).to.equal(60 * 3 + 90);
    expect(cheapestUnitsTotal(order, 0)).to.equal(0);
    expect(cheapestUnitsTotal(order, 99)).to.equal(300 + 180 + 90);
  });

  it('frees the 5 cheapest of 15 items on Get 3, Pay 2', async () => {
    const result = await discountFor(3, lines(15));
    // 100 + 110 + 120 + 130 + 140
    expect(result).to.containEql({valid: true, discountAmount: 600});
  });

  it('only counts full groups: 16 items still free 5 on Get 3, Pay 2', async () => {
    expect(await discountFor(3, lines(16))).to.containEql({discountAmount: 600});
  });

  it('frees one item for exactly one group', async () => {
    expect(await discountFor(3, lines(3))).to.containEql({discountAmount: 100});
  });

  it('frees one per group of 4 on Get 4, Pay 3', async () => {
    // 15 items -> 3 free: 100 + 110 + 120
    expect(await discountFor(4, lines(15))).to.containEql({discountAmount: 330});
  });

  it('counts a multi-quantity line as several items', async () => {
    // 6 shirts at 50 each and 3 sarees at 200 each: 9 items -> 3 free shirts
    const result = await discountFor(3, [
      {itemId: 'shirt', serviceId: 'clean', quantity: 6, totalPrice: 300},
      {itemId: 'saree', serviceId: 'clean', quantity: 3, totalPrice: 600},
    ]);
    expect(result).to.containEql({discountAmount: 150});
  });

  it('still needs at least one full group', async () => {
    const result = await discountFor(3, lines(2));
    expect(result).to.containEql({valid: false});
  });

  it('frees a single item when the coupon has no group size', async () => {
    expect(await discountFor(undefined, lines(15))).to.containEql({discountAmount: 100});
  });
});
