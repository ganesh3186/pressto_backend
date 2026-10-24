import {expect} from '@loopback/testlab';
import {CouponController} from '../controllers/coupon.controller';
import {CouponDiscountType} from '../models';
import {CouponService} from '../services/coupon.service';

describe('code-entry coupons', () => {
  it('rejects referral coupons on create and partial update', async () => {
    const controller = Object.assign(Object.create(CouponController.prototype), {
      couponRepository: {
        findOne: async () => ({code: 'SECRET10', isReferralCode: true, hideFromTicketList: false}),
        updateById: async () => { throw new Error('invalid coupon was saved'); },
      },
    }) as CouponController;

    await expect(controller.create({} as never, {
      code: 'SECRET10',
      name: 'Private offer',
      discountType: CouponDiscountType.PERCENTAGE,
      discountValue: 10,
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      isReferralCode: true,
      hideFromTicketList: true,
    })).to.be.rejectedWith(/Referral coupons cannot be hidden/);
    await expect(controller.updateById({} as never, 'coupon-1', {
      hideFromTicketList: true,
    })).to.be.rejectedWith(/Referral coupons cannot be hidden/);
  });

  it('skips automatic new-customer selection but accepts the entered code', async () => {
    const coupon = {
      id: 'coupon-1',
      code: 'SECRET10',
      name: 'Private offer',
      discountType: 'percentage',
      discountValue: 10,
      hideFromTicketList: true,
      newCustomerOrderLimit: 1,
    };
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {
        find: async ({where}: {where: {hideFromTicketList: boolean}}) => {
          expect(where.hideFromTicketList).to.equal(false);
          return [];
        },
        findOne: async () => coupon,
      },
      orderRepo: {count: async () => ({count: 0})},
      isWithinValidityWindow: () => true,
      usageCapacityReason: async () => null,
      geoScopeReason: async () => null,
      audienceScopeReason: async () => null,
    }) as CouponService;
    const items = [{serviceId: 'service-1', itemId: 'item-1', quantity: 1, totalPrice: 200}];

    expect(await service.evaluateNewCustomerCoupon('customer-1', 'store-1', items)).to.be.undefined();
    const result = await service.evaluate({
      couponCode: 'secret10',
      customerId: 'customer-1',
      storeId: 'store-1',
      items,
    });
    expect(result.valid).to.equal(true);
    if (result.valid) expect(result.discountAmount).to.equal(20);
  });
});
