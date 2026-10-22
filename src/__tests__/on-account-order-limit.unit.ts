import {expect} from '@loopback/testlab';
import {OrderType} from '../models/order-type.enum';
import {CreateOrderInput, OrderService} from '../services/order.service';

describe('on-account order creation', () => {
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
