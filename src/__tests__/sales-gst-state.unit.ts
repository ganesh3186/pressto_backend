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
      // Invoices in the window are fetched before orders — this one
      // references an order the state filter then has to narrow away.
      invoiceRepo: {
        execute: async (_sql: string, params: unknown[]) => {
          orderStoreIds = params[0] as string[];
          return [{count:0, page:[],taxable:0,tax:0,total:0}];
        },
      },
      orderRepo: {
        find: async ({where}: {where: {id: {inq: string[]}; storeId: {inq: string[]}}}) => {
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
