import {expect} from '@loopback/testlab';
import {OrderType} from '../models/order-type.enum';
import {CreateOrderInput, OrderService} from '../services/order.service';

describe('on-account order creation', () => {
  it('rejects On Account billing for an ineligible billed customer', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      customerRepo: {findOne: async () => ({id: 'customer-1', isOnAccountEligible: false})},
    }) as OrderService;
    await expect(service.createOrder({customerId: 'customer-1', storeId: 'store-1',
      orderType: OrderType.STORE_DROPOFF, paymentIsOnAccount: true,
      items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}]}, 'employee-1'))
      .to.be.rejectedWith('This customer is not eligible for On Account billing.');
  });

  it('continues to persistence when the order exceeds available credit', async () => {
    const reachedPersistence = new Error('reached order persistence');
    const service = Object.assign(Object.create(OrderService.prototype), {
      customerRepo: {findOne: async () => ({customerEntityType: 'business'})},
      storeRepo: {findOne: async () => ({id: 'store-1'})},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      resolveNextOrderNumber: async () => 'ORD-1',
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({
        basePrice: 100,
        appliedPercentage: null,
        priceSource: 'test',
        resolvedPrice: 100,
        estimatedDurationInDays: 0,
      }),
      itemRepo: {findById: async () => ({isMeasurement: false})},
      serviceRepo: {findOne: async () => ({name: 'Test Service'})},
      couponService: {
        evaluateReferralCoupon: async () => null,
        evaluateNewCustomerCoupon: async () => null,
      },
      resolveCustomerAutoDiscount: async () => ({
        discountAmount: 0,
        discountType: 'none',
      }),
      gstConfigRepo: {findOne: async () => null},
      computeOnAccountCreditStatus: async () => ({
        limit: 0,
        used: 0,
        remaining: 0,
      }),
      shiftRepo: {
        findOne: async () => {
          throw reachedPersistence;
        },
      },
    }) as OrderService;
    const input: CreateOrderInput = {
      customerId: 'customer-1',
      storeId: 'store-1',
      orderType: OrderType.STORE_DROPOFF,
      items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}],
      paymentIsOnAccount: true,
    };

    let error: unknown;
    try {
      await service.createOrder(input, 'employee-1');
    } catch (caught) {
      error = caught;
    }
    expect(error).to.equal(reachedPersistence);
  });
});

describe('coupon booking at order creation', () => {
  for (const changedEvaluation of [
    {valid: false, reason: 'Coupon not found.'},
    {valid: true, coupons: [{couponId: 'coupon-1', code: 'SAVE10',
      discountAmount: 20, pricingSnapshot: {id: 'coupon-1', discountValue: 20}}]},
  ]) {
    it('rolls back when coupon terms change before booking', async () => {
      let evaluations = 0;
      let rolledBack = false;
      let redeemed = false;
      const originalCoupon = {couponId: 'coupon-1', code: 'SAVE10', discountAmount: 10,
        discountType: 'fixed', pricingSnapshot: {id: 'coupon-1', discountValue: 10}};
      const service = Object.assign(Object.create(OrderService.prototype), {
        customerRepo: {findOne: async () => ({})},
        storeRepo: {findOne: async () => ({id: 'store-1'})},
        assertItemsHaveRequiredAdditionalServices: async () => {},
        resolveNextOrderNumber: async () => 'ORD-1',
        resolveAdditionalChargePercentage: async () => 0,
        resolvePricing: async () => ({basePrice: 100, appliedPercentage: null,
          priceSource: 'test', resolvedPrice: 100, estimatedDurationInDays: 0}),
        itemRepo: {findById: async () => ({isMeasurement: false})},
        serviceRepo: {findOne: async () => ({name: 'Test Service'})},
        couponService: {evaluateMultiple: async () =>
          ++evaluations === 1 ? {valid: true, coupons: [originalCoupon]} : changedEvaluation},
        gstConfigRepo: {findOne: async () => null},
        shiftRepo: {findOne: async () => null},
        orderRepo: {create: async () => ({id: 'order-1'})},
        lockStorePrefix: async () => {},
        lockCouponCodes: async () => {},
        couponRedemptionRepo: {create: async () => {redeemed = true;}},
        dataSource: {execute: async () => {}, beginTransaction: async () => ({commit: async () => {},
          rollback: async () => {rolledBack = true;}})},
      }) as OrderService;

      await expect(service.createOrder({customerId: 'customer-1', storeId: 'store-1',
        orderType: OrderType.STORE_DROPOFF,
        items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}],
        couponCodes: ['SAVE10']}, 'employee-1'))
        .to.be.rejectedWith('Coupon changed while creating the ticket. Review and retry.');
      expect(evaluations).to.equal(2);
      expect(rolledBack).to.equal(true);
      expect(redeemed).to.equal(false);
    });
  }

  it('rejects a referral when another order commits before the customer lock', async () => {
    let locked = false;
    let created = false;
    let rolledBack = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      customerRepo: {findOne: async () => ({id: 'customer-1', referredByCouponId: 'coupon-1'})},
      storeRepo: {findOne: async () => ({id: 'store-1'})},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      resolveNextOrderNumber: async () => 'ORD-1',
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({basePrice: 100, appliedPercentage: null,
        priceSource: 'test', resolvedPrice: 100, estimatedDurationInDays: 0}),
      itemRepo: {findById: async () => ({isMeasurement: false})},
      serviceRepo: {findOne: async () => ({name: 'Test Service'})},
      couponService: {evaluateReferralCoupon: async () => ({couponId: 'coupon-1',
        code: 'REFERRED', discountAmount: 10, discountType: 'fixed'} as object)},
      gstConfigRepo: {findOne: async () => null},
      shiftRepo: {findOne: async () => null},
      orderRepo: {count: async () => ({count: 1}), create: async () => {created = true;}},
      dataSource: {execute: async () => {locked = true;}, beginTransaction: async () => ({
        commit: async () => {}, rollback: async () => {rolledBack = true;},
      })},
    }) as OrderService;

    await expect(service.createOrder({customerId: 'customer-1', storeId: 'store-1',
      orderType: OrderType.STORE_DROPOFF,
      items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}]}, 'employee-1'))
      .to.be.rejectedWith('Referral coupon is only available on the first ticket. Review and retry.');
    expect(locked).to.equal(true);
    expect(created).to.equal(false);
    expect(rolledBack).to.equal(true);
  });

  it('does not apply the referral first-order guard to a customer without a referral', async () => {
    const reachedPersistence = new Error('reached order persistence');
    const service = Object.assign(Object.create(OrderService.prototype), {
      customerRepo: {findOne: async () => ({id: 'customer-1'})},
      storeRepo: {findOne: async () => ({id: 'store-1'})},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      resolveNextOrderNumber: async () => 'ORD-1',
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({basePrice: 100, appliedPercentage: null,
        priceSource: 'test', resolvedPrice: 100, estimatedDurationInDays: 0}),
      itemRepo: {findById: async () => ({isMeasurement: false})},
      serviceRepo: {findOne: async () => ({name: 'Test Service'})},
      couponService: {evaluateReferralCoupon: async () => null,
        evaluateNewCustomerCoupon: async () => null},
      resolveCustomerAutoDiscount: async () => ({discountAmount: 0, discountType: 'none'}),
      gstConfigRepo: {findOne: async () => null},
      shiftRepo: {findOne: async () => null},
      orderRepo: {count: async () => {throw new Error('unexpected first-order check');},
        create: async () => {throw reachedPersistence;}},
      dataSource: {execute: async () => {}, beginTransaction: async () => ({
        commit: async () => {}, rollback: async () => {},
      })},
    }) as OrderService;

    let error: unknown;
    try {
      await service.createOrder({customerId: 'customer-1', storeId: 'store-1',
        orderType: OrderType.STORE_DROPOFF,
        items: [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}]}, 'employee-1');
    } catch (caught) {
      error = caught;
    }
    expect(error).to.equal(reachedPersistence);
  });
});
