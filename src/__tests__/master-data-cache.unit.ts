import {expect} from '@loopback/testlab';
import {ServiceItemPricesController} from '../controllers/service-item-prices.controller';
import {
  MASTER_DATA_TABLES,
  MASTER_DATA_VERSION_SQL,
  masterDataVersionFrom,
} from '../controllers/master-data-version.controller';
import {CouponDiscountType} from '../models';

const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();

function buildController(opts: {customerLabels: Record<string, string[]>}) {
  const mappings = [
    {id: 'm1', serviceId: 'wash', itemId: 'shirt', basePrice: 100, estimatedDurationInDays: 2, additionalServiceIds: ['starch']},
    {id: 'm2', serviceId: 'starch', itemId: 'shirt', basePrice: 20, estimatedDurationInDays: 1, additionalServiceIds: []},
    {id: 'm3', serviceId: 'wash', itemId: 'saree', basePrice: 300, estimatedDurationInDays: 3, additionalServiceIds: ['starch']},
    {id: 'm4', serviceId: 'starch', itemId: 'saree', basePrice: 40, estimatedDurationInDays: 1, additionalServiceIds: []},
  ];
  const coupons = [
    // Applies to everyone: saree wash at 250.
    {id: 'open', discountType: CouponDiscountType.PRICE_OVERRIDE, startDate: past, endDate: future, customerLabelIds: []},
    // Only for customers labelled "vip": shirt wash at 70, starch on shirt at 10, saree wash at 200.
    {id: 'vip', discountType: CouponDiscountType.PRICE_OVERRIDE, startDate: past, endDate: future, customerLabelIds: ['vip']},
    // Expired vip coupon must never show.
    {id: 'old', discountType: CouponDiscountType.PRICE_OVERRIDE, startDate: past, endDate: past, customerLabelIds: ['vip']},
  ];
  const overrides = [
    {couponId: 'open', serviceId: 'wash', itemId: 'saree', overridePrice: 250},
    {couponId: 'vip', serviceId: 'wash', itemId: 'shirt', overridePrice: 70},
    {couponId: 'vip', serviceId: 'starch', itemId: 'shirt', overridePrice: 10},
    {couponId: 'vip', serviceId: 'wash', itemId: 'saree', overridePrice: 200},
    {couponId: 'old', serviceId: 'wash', itemId: 'shirt', overridePrice: 1},
  ];
  return Object.assign(Object.create(ServiceItemPricesController.prototype), {
    storeRepository: {findById: async () => ({id: 'store', clusterId: 'cluster', isDeleted: false})},
    clusterRepository: {findById: async () => ({id: 'cluster', regionId: 'region', isDeleted: false})},
    // 10% store uplift on everything that has no coupon price.
    storePriceOverrideRepository: {findOne: async () => ({percentage: 10})},
    clusterPriceListRepository: {findOne: async () => null},
    priceListRepository: {findOne: async () => null},
    serviceItemMappingRepository: {find: async () => mappings},
    serviceRepository: {
      find: async () => [
        {id: 'wash', name: 'Wash', code: 'W'},
        {id: 'starch', name: 'Starch', code: 'S'},
      ],
    },
    couponPriceOverrideRepository: {
      find: async (filter: {where: {couponId?: {inq: string[]}}}) =>
        overrides.filter(o => !filter.where.couponId || filter.where.couponId.inq.includes(o.couponId)),
    },
    couponRepository: {
      find: async (filter: {where: {id?: {inq: string[]}; discountType?: string}}) =>
        coupons.filter(c =>
          (!filter.where.id || filter.where.id.inq.includes(c.id)) &&
          (!filter.where.discountType || c.discountType === filter.where.discountType)),
    },
    customerLabelAssignmentRepository: {
      find: async (filter: {where: {customerId: string}}) =>
        (opts.customerLabels[filter.where.customerId] ?? []).map(customerLabelId => ({customerLabelId})),
    },
  }) as ServiceItemPricesController;
}

// The exact merge the admin panel performs (src/api/service-item-price.js).
function applyOverrides(
  rows: Awaited<ReturnType<ServiceItemPricesController['getServiceItemPrices']>>,
  overrides: {serviceId: string; itemId: string; resolvedPrice: number}[],
) {
  const byPair = new Map(overrides.map(o => [`${o.serviceId}:${o.itemId}`, o.resolvedPrice]));
  return rows.map(row => {
    const own = byPair.get(`${row.serviceId}:${row.itemId}`);
    return {
      ...row,
      ...(own != null ? {resolvedPrice: own, priceSource: 'coupon' as const, appliedPercentage: null} : {}),
      additionalServices: row.additionalServices.map(add => {
        const price = byPair.get(`${add.serviceId}:${row.itemId}`);
        return price != null ? {...add, resolvedPrice: price} : add;
      }),
    };
  });
}

describe('master data caching', () => {
  const controller = buildController({customerLabels: {vipCustomer: ['vip'], plainCustomer: ['other']}});

  it('store list + customer overrides equals the full list for that customer', async () => {
    const storeList = await controller.getServiceItemPrices('store');
    for (const customerId of ['vipCustomer', 'plainCustomer', 'unknownCustomer']) {
      const full = await controller.getServiceItemPrices('store', customerId);
      const overrides = await controller.getCustomerPriceOverrides('store', customerId);
      expect(applyOverrides(storeList, overrides)).to.deepEqual(full);
    }
  });

  it('returns only the label-gated prices that differ, and nothing for other customers', async () => {
    const vip = await controller.getCustomerPriceOverrides('store', 'vipCustomer');
    const byKey = (a: {serviceId: string; itemId: string}, b: {serviceId: string; itemId: string}) =>
      `${a.serviceId}:${a.itemId}`.localeCompare(`${b.serviceId}:${b.itemId}`);
    expect([...vip].sort(byKey)).to.deepEqual(
      [
        {serviceId: 'wash', itemId: 'shirt', resolvedPrice: 70},
        {serviceId: 'starch', itemId: 'shirt', resolvedPrice: 10},
        {serviceId: 'wash', itemId: 'saree', resolvedPrice: 200},
      ].sort(byKey),
    );
    expect(await controller.getCustomerPriceOverrides('store', 'plainCustomer')).to.deepEqual([]);
  });

  it('requires a customer and a store', async () => {
    await expect(controller.getCustomerPriceOverrides('store', '')).to.be.rejectedWith(/customerId is required/);
    await expect(controller.getCustomerPriceOverrides('', 'vipCustomer')).to.be.rejectedWith(/storeId is required/);
  });

  it('master data version changes when any master table changes', () => {
    const rows = MASTER_DATA_TABLES.map(t => ({t, n: '5', u: '2026-11-01 10:00:00'}));
    const base = masterDataVersionFrom(rows);
    expect(masterDataVersionFrom([...rows].reverse())).to.equal(base);
    const edited = rows.map(r => (r.t === 'service_item_mapping' ? {...r, u: '2026-11-07 09:00:00'} : r));
    const deleted = rows.map(r => (r.t === 'coupon' ? {...r, n: '4'} : r));
    expect(masterDataVersionFrom(edited)).to.not.equal(base);
    expect(masterDataVersionFrom(deleted)).to.not.equal(base);
    for (const table of MASTER_DATA_TABLES) expect(MASTER_DATA_VERSION_SQL).to.containEql(`FROM public.${table}`);
  });

  it('ignores the counters and locks that every order writes to store and coupon', () => {
    const part = (table: string) =>
      MASTER_DATA_VERSION_SQL.split(' UNION ALL ').find(s => s.endsWith(`FROM public.${table}`))!;
    for (const counter of ['ordernumbersequence', 'isprefixlocked', 'updatedat']) {
      expect(part('store')).to.not.containEql(counter);
    }
    for (const counter of ['totalusescount', 'updatedat', 'updatedby']) {
      expect(part('coupon')).to.not.containEql(counter);
    }
    expect(part('store')).to.containEql('storeprefix');
    expect(part('store')).to.containEql('gstnumber');
    expect(part('coupon')).to.containEql('enddate');
    expect(part('brand')).to.containEql('max(updatedat)');
  });
});
