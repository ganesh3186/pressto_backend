import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';
import {OrderType} from '../models/order-type.enum';
import {ShiftStatus} from '../models/shift-status.enum';

describe('consolidated daily sales revenue', () => {
  it('keeps on-account and normal invoice channel totals aligned with closure revenue', async () => {
    const openedAt = new Date('2026-10-01T09:00:00Z');
    const closedAt = new Date('2026-10-01T17:00:00Z');
    const shift = {
      id: 'shift-a',
      storeId: 'store-a',
      status: ShiftStatus.CLOSED,
      openedAt,
      closedAt,
      openingNo: 'S-1',
      closing: {
        revenue: {pressto: {revenue: 100.5, totalSales: 100.5}},
        salesReturn: {pressto: {totalSales: 12, services: 1}},
      },
    };
    const invoices = [
      {
        id: 'on-account',
        orderId: 'order-a',
        isConsolidated: true,
        subtotal: 100.5,
        totalAmount: 101,
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        id: 'normal',
        orderId: 'order-c',
        isConsolidated: false,
        subtotal: 50.25,
        totalAmount: 50.25,
        createdAt: new Date('2026-10-01T11:00:00Z'),
      },
    ];
    const service = Object.assign(Object.create(ReportsService.prototype), {
      shiftRepo: {find: async () => [shift]},
      buildStoreContext: async () =>
        new Map([
          [
            'store-a',
            {
              name: 'Store A',
              code: 'A',
              clusterName: 'North',
              regionName: 'North',
            },
          ],
        ]),
      orderRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.createdAt
            ? []
            : [
                {
                  id: 'order-a',
                  storeId: 'store-a',
                  orderType: OrderType.STORE_DROPOFF,
                },
                {
                  id: 'order-b',
                  storeId: 'store-b',
                  orderType: OrderType.HOME_PICKUP,
                },
                {
                  id: 'order-c',
                  storeId: 'store-a',
                  orderType: OrderType.HOME_PICKUP,
                },
              ],
      },
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {find: async () => invoices},
      invoiceOrderLinkRepo: {
        find: async () => [
          {invoiceId: 'on-account', orderId: 'order-a', orderTotal: 50.25},
          {invoiceId: 'on-account', orderId: 'order-b', orderTotal: 50.25},
        ],
      },
    }) as ReportsService;

    const report = await service.buildConsolidatedDailySales({
      storeIds: ['store-a'],
      from: openedAt,
      to: closedAt,
    });
    const row = report.rows[0] as {
      psbRevenue: number;
      p2dRevenue: number;
      revenue: number;
      salesReturnSaleAmount: number;
      noOfSalesReturnServices: number;
    };
    expect(row).to.containEql({
      psbRevenue: 50.25,
      p2dRevenue: 50.25,
      revenue: 100.5,
      salesReturnSaleAmount: 12,
      noOfSalesReturnServices: 1,
    });
    expect(report.totals).to.containEql({
      psbRevenue: 50.25,
      p2dRevenue: 50.25,
      revenue: 100.5,
      salesReturnSaleAmount: 12,
    });
  });

  it('uses the saved net revenue and return amount for a return-only shift', async () => {
    const openedAt = new Date('2026-10-02T09:00:00Z');
    const closedAt = new Date('2026-10-02T17:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      shiftRepo: {
        find: async () => [
          {
            id: 'shift-b',
            storeId: 'store-a',
            status: ShiftStatus.CLOSED,
            openedAt,
            closedAt,
            openingNo: 'S-2',
            closing: {
              revenue: {pressto: {revenue: -30, totalSales: -30}},
              salesReturn: {pressto: {totalSales: 30, services: 1}},
            },
          },
        ],
      },
      buildStoreContext: async () => new Map(),
      orderRepo: {find: async () => []},
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildConsolidatedDailySales({
      storeIds: ['store-a'],
      from: openedAt,
      to: closedAt,
    });

    expect(report.rows[0]).to.containEql({
      revenue: -30,
      salesReturnSaleAmount: 30,
      noOfSalesReturnServices: 1,
      psbRevenue: 0,
      p2dRevenue: 0,
    });
    expect(report.totals).to.containEql({
      revenue: -30,
      salesReturnSaleAmount: 30,
    });
  });

  it('uses the remaining on-account link share in the mode of payment report', async () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {
        find: async () => [
          {id: 'order-a', storeId: 'store-a'},
          {id: 'order-b', storeId: 'store-b'},
        ],
      },
      buildWalletTopUpRows: async () => [],
      invoiceRepo: {
        find: async () => [
          {
            id: 'on-account',
            invoiceNumber: 'INV-1',
            orderId: 'order-a',
            createdAt,
          },
        ],
      },
      invoiceOrderLinkRepo: {
        find: async () => [
          {invoiceId: 'on-account', orderId: 'order-a', orderTotal: 40.25},
          {invoiceId: 'on-account', orderId: 'order-b', orderTotal: 60.25},
        ],
      },
      storeRepo: {find: async () => [{id: 'store-a', name: 'Store A'}]},
      customerRepo: {find: async () => []},
      paymentTransactionRepo: {find: async () => []},
      mapOnAccountInvoiceNumbers: async () => new Map(),
      mapStores: async () => new Map(),
      mapShifts: async () => new Map(),
      mapCustomers: async () => new Map(),
    }) as ReportsService;

    const report = await service.buildModeOfPayment({
      storeIds: ['store-a'],
      from: createdAt,
      to: createdAt,
      limit: 10,
      skip: 0,
    });

    expect(report.rows).to.have.length(1);
    expect(report.rows[0]).to.containEql({
      id: 'on-account-invoice:on-account:store-a',
      amount: 40.25,
    });
    expect(report.totals).to.containEql({amount: 40.25});
  });
});
