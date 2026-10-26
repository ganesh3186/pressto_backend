import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('additional service pricing', () => {
  it('rejects a zero resolved price only when selected as an additional service', async () => {
    let basePrice = 0;
    let couponPrice: number | null = null;
    let storePercentage: number | null = null;
    const service = Object.assign(Object.create(OrderService.prototype), {
      serviceItemMappingRepo: {
        findOne: async () => ({basePrice, estimatedDurationInDays: 1}),
      },
      resolveCouponOverridePrice: async () => couponPrice,
      storePriceOverrideRepo: {
        findOne: async () => storePercentage == null ? null : {percentage: storePercentage},
      },
      storeRepo: {findById: async () => ({clusterId: null})},
    }) as OrderService;

    expect((await service.resolvePricing('store', 'darning', 'shirt', 'customer')).resolvedPrice).to.equal(0);
    await expect(service.resolvePricing('store', 'darning', 'shirt', 'customer', {additional: true}))
      .to.be.rejectedWith(/unavailable at Rs.0/);

    basePrice = 50;
    couponPrice = 0;
    await expect(service.resolvePricing('store', 'darning', 'shirt', 'customer', {additional: true}))
      .to.be.rejectedWith(/unavailable at Rs.0/);

    couponPrice = null;
    storePercentage = -100;
    await expect(service.resolvePricing('store', 'darning', 'shirt', 'customer', {additional: true}))
      .to.be.rejectedWith(/unavailable at Rs.0/);

    storePercentage = null;
    expect((await service.resolvePricing('store', 'darning', 'shirt', 'customer', {additional: true})).resolvedPrice)
      .to.equal(50);
  });
});
