import {expect} from '@loopback/testlab';
import {CouponController} from '../controllers/coupon.controller';
import {CouponDiscountType} from '../models';
import {CouponMinRequirementType} from '../models/coupon-min-requirement-type.enum';
import {CouponService} from '../services/coupon.service';

describe('code-entry coupons', () => {
  it('shows committed uses without counting a saved draft selection', async () => {
    const controller = Object.assign(Object.create(CouponController.prototype), {
      couponRepository: {findOne: async () => ({id: 'coupon-1', totalUsesCount: 1})},
      couponRedemptionRepository: {find: async (filter: {where: object}) => {
        expect(filter.where).to.containEql({couponId: 'coupon-1', isProvisional: false});
        return [{id: 'redemption-1', customerId: 'customer-1', isReversed: false}];
      }},
      customerRepository: {find: async () => []},
    }) as CouponController;
    const history = await controller.redemptions('coupon-1') as {
      redemptions: object[]; summary: {totalUsesCount: number; uniqueCustomersUsed: number};
    };
    expect(history.redemptions).to.have.length(1);
    expect(history.summary).to.containEql({totalUsesCount: 1, uniqueCustomersUsed: 1});
  });
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

  it('lets a draft keep its own once-per-customer coupon', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async () => ({
        id: 'coupon-1', code: 'ONCE', discountType: 'percentage', discountValue: 10,
        maxUsesTotal: 1, totalUsesCount: 1, maxUsesPerCustomer: 1,
        newCustomerOrderLimit: 1,
      })},
      couponRedemptionRepo: {
        findOne: async () => ({orderId: 'draft-1', customerId: 'customer-1'}),
        count: async () => ({count: 1}),
      },
      orderRepo: {count: async (where: {id?: unknown}) => ({count: where.id ? 0 : 1})},
      isWithinValidityWindow: () => true,
      geoScopeReason: async () => null,
      audienceScopeReason: async () => null,
    }) as CouponService;
    const input = {couponCode: 'ONCE', customerId: 'customer-1', storeId: 'store-1',
      items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1, totalPrice: 200}]};

    expect((await service.evaluate(input)).valid).to.equal(false);
    const savedDraft = await service.evaluate({...input, excludeOrderId: 'draft-1'});
    expect(savedDraft.valid).to.equal(true);
    if (savedDraft.valid) expect(savedDraft.discountAmount).to.equal(20);
  });

  it('previews a draft coupon after changing customers without transferring referral access', async () => {
    let evaluated: {customerId: string; excludeOrderId?: string; allowReferralCouponCodes?: string[]} | undefined;
    const controller = Object.assign(Object.create(CouponController.prototype), {
      orderRepository: {findOne: async (filter: {where: object}) => {
        expect(filter.where).to.not.have.property('storeId');
        return {id: 'draft-1', customerId: 'customer-1'};
      }},
      couponRedemptionRepository: {find: async () => [{
        orderId: 'draft-1', customerId: 'customer-1', couponCodeSnapshot: 'ONCE',
      }]},
      couponService: {evaluateMultiple: async (input: typeof evaluated) => {
        evaluated = input;
        return {valid: true, coupons: []};
      }},
    }) as CouponController;
    const body = {couponCodes: ['ONCE'], customerId: 'customer-2', storeId: 'store-1',
      existingDraftOrderId: 'draft-1', items: []};

    await controller.validateMultiple(body);
    expect(evaluated).to.containEql({customerId: 'customer-2', excludeOrderId: 'draft-1',
      allowReferralCouponCodes: []});
    await controller.validateMultiple({...body, customerId: 'customer-1'});
    expect(evaluated?.allowReferralCouponCodes).to.deepEqual(['ONCE']);
    await controller.validateMultiple({...body, storeId: 'store-2'});
    expect(evaluated).to.containEql({storeId: 'store-2', excludeOrderId: 'draft-1'});
  });

  it('rechecks the committed coupon count before redemption', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findById: async () => ({id: 'coupon-1', maxUsesTotal: 1, totalUsesCount: 1})},
      couponRedemptionRepo: {findOne: async () => null},
    }) as CouponService;

    const reason = await service.redemptionCapacityReason('coupon-1', 'customer-2', {} as never);
    expect(reason).to.equal('This coupon has reached its usage limit.');
  });

  it('grandfathers a redeemed coupon but still checks its edited items', async () => {
    const coupon = {id: 'coupon-1', code: 'EXPIRED', name: 'Old offer',
      discountType: CouponDiscountType.FIXED, discountValue: 20,
      isActive: false, isDeleted: false, itemIds: ['shirt']};
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async ({where}: {where: {isActive?: boolean}}) =>
        where.isActive ? null : coupon},
      serviceRepo: {find: async () => []},
      itemRepo: {find: async () => []},
      isWithinValidityWindow: () => false,
    }) as CouponService;
    const input = {couponCode: 'EXPIRED', customerId: 'customer-1', storeId: 'store-1',
      items: [{serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: 200}]};

    expect((await service.evaluate(input)).valid).to.equal(false);
    expect((await service.evaluate(input, true)).valid).to.equal(true);
    const noMatchingItems = await service.evaluate({...input, items: [
      {serviceId: 'clean', itemId: 'trousers', quantity: 1, totalPrice: 200},
    ]}, true);
    expect(noMatchingItems.valid).to.equal(false);
  });

  it('uses booked item and minimum rules after the coupon is edited', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async () => {throw new Error('live coupon rules were read');}},
      serviceRepo: {find: async () => []},
      itemRepo: {find: async () => []},
    }) as CouponService;
    const input = {couponCodes: ['SHIRT'], customerId: 'customer-1', storeId: 'store-1',
      items: [{serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: 100}]};
    const booked = {id: 'coupon-1', code: 'SHIRT', name: 'Shirt offer',
      discountType: CouponDiscountType.FIXED, discountValue: 20, itemIds: ['shirt'],
      minRequirementType: CouponMinRequirementType.AMOUNT, minRequirementValue: 50};

    const result = await service.evaluateMultiple(input, true, [booked]);
    expect(result.valid).to.equal(true);
    if (result.valid) expect(result.coupons[0].eligibleSubtotal).to.equal(100);
    const removed = await service.evaluateMultiple({...input, items: [
      {serviceId: 'clean', itemId: 'trousers', quantity: 1, totalPrice: 100},
    ]}, true, [booked]);
    expect(removed.valid).to.equal(false);
    const belowBookedMinimum = await service.evaluateMultiple({...input, items: [
      {serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: 40},
    ]}, true, [booked]);
    expect(belowBookedMinimum.valid).to.equal(false);
  });

  it('keeps booked category membership after catalog recategorization', async () => {
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async () => {throw new Error('live coupon rules were read');}},
      serviceRepo: {find: async () => [{id: 'clean', serviceCategoryId: 'new-service-category'}]},
      itemRepo: {find: async () => [{id: 'shirt', itemCategoryId: 'new-item-category'}]},
    }) as CouponService;
    const input = {couponCodes: ['CATEGORY'], customerId: 'customer-1', storeId: 'store-1',
      items: [{serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: 100}]};
    const booked = {id: 'coupon-1', code: 'CATEGORY', name: 'Category offer',
      discountType: CouponDiscountType.FIXED, discountValue: 20,
      serviceCategoryIds: ['old-service-category'], itemCategoryIds: ['old-item-category'],
      serviceCategoryById: {clean: 'old-service-category'},
      itemCategoryById: {shirt: 'old-item-category'}};

    const result = await service.evaluateMultiple(input, true, [booked]);
    expect(result.valid).to.equal(true);
    if (result.valid) expect(result.coupons[0].eligibleSubtotal).to.equal(100);
  });

  it('returns the exact coupon and categories used during validation', async () => {
    const coupon = {id: 'coupon-1', code: 'CATEGORY', name: 'Category offer',
      discountType: CouponDiscountType.FIXED, discountValue: 20,
      serviceCategoryIds: ['old-service-category'], itemCategoryIds: ['old-item-category']};
    let serviceCategoryId = 'old-service-category';
    let itemCategoryId = 'old-item-category';
    const service = Object.assign(Object.create(CouponService.prototype), {
      couponRepo: {findOne: async () => coupon},
      serviceRepo: {find: async () => [{id: 'clean', serviceCategoryId}]},
      itemRepo: {find: async () => [{id: 'shirt', itemCategoryId}]},
      isWithinValidityWindow: () => true,
      usageCapacityReason: async () => null,
      geoScopeReason: async () => null,
      audienceScopeReason: async () => null,
    }) as CouponService;

    const input = {couponCode: 'CATEGORY', customerId: 'customer-1', storeId: 'store-1',
      items: [{serviceId: 'clean', itemId: 'shirt', quantity: 1, totalPrice: 100}]};
    const result = await service.evaluate(input);
    expect(result.valid).to.equal(true);
    if (!result.valid) return;
    serviceCategoryId = 'new-service-category';
    itemCategoryId = 'new-item-category';
    coupon.itemCategoryIds[0] = 'new-item-category';
    expect((await service.evaluate(input)).valid).to.equal(false);
    expect(result.pricingSnapshot.serviceCategoryById).to.deepEqual({clean: 'old-service-category'});
    expect(result.pricingSnapshot.itemCategoryById).to.deepEqual({shirt: 'old-item-category'});
    expect(result.pricingSnapshot.itemCategoryIds).to.deepEqual(['old-item-category']);
  });
});
