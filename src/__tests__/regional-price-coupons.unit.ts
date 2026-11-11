import {expect} from '@loopback/testlab';
import {ServiceItemPricesController} from '../controllers/service-item-prices.controller';
import {CouponDiscountType} from '../models';
import {CouponService} from '../services/coupon.service';

const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();

const COUPONS = [
  {id: 'blr', discountType: CouponDiscountType.PRICE_OVERRIDE, startDate: past, endDate: future, storeIds: ['blr-store']},
  {id: 'hyd', discountType: CouponDiscountType.PRICE_OVERRIDE, startDate: past, endDate: future, storeIds: ['hyd-store']},
];
const OVERRIDES = [
  {couponId: 'blr', serviceId: 'clean', itemId: 'shirt', overridePrice: 95},
  {couponId: 'hyd', serviceId: 'clean', itemId: 'shirt', overridePrice: 76},
];

function pricesController(requestedCouponIds: string[][]) {
  return Object.assign(Object.create(ServiceItemPricesController.prototype), {
    couponRepository: {
      find: async (filter: {where: {discountType?: string}}) =>
        COUPONS.filter(c => !filter.where.discountType || c.discountType === filter.where.discountType),
    },
    couponPriceOverrideRepository: {
      find: async (filter: {where: {couponId: {inq: string[]}}}) => {
        requestedCouponIds.push(filter.where.couponId.inq);
        return OVERRIDES.filter(o => filter.where.couponId.inq.includes(o.couponId));
      },
    },
    customerLabelAssignmentRepository: {find: async () => []},
  }) as ServiceItemPricesController;
}

type OverrideMapBuilder = {
  buildCouponOverrideMap(storeId: string, clusterId: string, regionId: string): Promise<Map<string, number>>;
};

describe('regional price coupons', () => {
  it('loads only the price rows of the coupons for this store', async () => {
    const requested: string[][] = [];
    const controller = pricesController(requested) as unknown as OverrideMapBuilder;

    const prices = await controller.buildCouponOverrideMap('blr-store', 'cluster', 'region');

    expect([...prices]).to.deepEqual([['clean:shirt', 95]]);
    expect(requested).to.deepEqual([['blr']]);
  });

  it('loads no price rows for a store no coupon covers', async () => {
    const requested: string[][] = [];
    const controller = pricesController(requested) as unknown as OverrideMapBuilder;

    const prices = await controller.buildCouponOverrideMap('base-store', 'cluster', 'region');

    expect(prices.size).to.equal(0);
    expect(requested).to.deepEqual([]);
  });

  it('is left out of the offers a customer can browse', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {find: async () => [{...COUPONS[0], code: 'REGION-BLR', isActive: true}]},
    }) as CouponService;

    expect(await service.listEligibleForDisplay('customer-1', 'blr-store')).to.deepEqual([]);
  });

  it('cannot be entered as a coupon code', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async () => ({...COUPONS[0], code: 'REGION-BLR', isActive: true})},
    }) as CouponService;

    const result = await service.evaluate({
      couponCode: 'region-blr',
      customerId: 'customer-1',
      storeId: 'blr-store',
      items: [],
    } as never);

    expect(result).to.containEql({valid: false});
    expect((result as {reason: string}).reason).to.match(/applies its prices automatically/);
  });
});
