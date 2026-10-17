import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';

describe('sales GST state filter', () => {
  it('loads orders only from scoped stores in the selected state', async () => {
    let orderStoreIds: string[] = [];
    const service = Object.assign(Object.create(ReportsService.prototype), {
      storeRepo: {
        find: async ({where}: {where: {id: {inq: string[]}; state: string}}) => {
          expect(where).to.deepEqual({id: {inq: ['store-a', 'store-b']}, state: 'Maharashtra'});
          return [{id: 'store-b'}];
        },
      },
      orderRepo: {
        find: async ({where}: {where: {storeId: {inq: string[]}}}) => {
          orderStoreIds = where.storeId.inq;
          return [];
        },
      },
    }) as ReportsService;

    const report = await service.buildSalesGst({
      storeIds: ['store-a', 'store-b'],
      state: 'Maharashtra',
      from: new Date('2026-10-01'),
      to: new Date('2026-10-02'),
      limit: 25,
      skip: 0,
    });

    expect(orderStoreIds).to.deepEqual(['store-b']);
    expect(report.totalCount).to.equal(0);
  });
});
