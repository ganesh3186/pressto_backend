import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';
import {OrderType} from '../models/order-type.enum';
import {ShiftStatus} from '../models/shift-status.enum';

describe('daily sales revenue', () => {
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
        cgst: 0,
        sgst: 0,
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
                  taxAmount: 7.2,
                  totalAmount: 47.2,
                },
                {
                  id: 'order-b',
                  storeId: 'store-b',
                  orderType: OrderType.HOME_PICKUP,
                  taxAmount: 7,
                  totalAmount: 57,
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
          {invoiceId: 'on-account', orderId: 'order-a', orderTotal: 38.45},
          {invoiceId: 'on-account', orderId: 'order-b', orderTotal: 50.25},
        ],
      },
      salesReturnRepo: {
        find: async () => [
          {
            orderId: 'order-a',
            creditAmount: 11.8,
            returnedItems: [{amount: 10}],
            resolvedAt: new Date('2026-10-02T10:00:00Z'),
          },
        ],
      },
      storeMonthlyTargetRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildDailySales({
      storeIds: ['store-a'],
      from: openedAt,
      to: closedAt,
    });
    const row = report.rows[0] as {
      psbRevenue: number;
      p2dRevenue: number;
      revenue: number;
      taxes: number;
      salesReturnSaleAmount: number;
      noOfSalesReturnServices: number;
    };
    expect(row).to.containEql({
      psbRevenue: 42.58,
      p2dRevenue: 50.25,
      revenue: 92.83,
      taxes: 7.67,
      salesReturnSaleAmount: 12,
      noOfSalesReturnServices: 1,
    });
    expect(report.totals).to.containEql({
      psbRevenue: 42.58,
      p2dRevenue: 50.25,
      revenue: 92.83,
      taxes: 7.67,
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
      storeMonthlyTargetRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildDailySales({
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

  it('does not move invoice rounding into revenue', async () => {
    const openedAt = new Date('2026-10-03T09:00:00Z');
    const closedAt = new Date('2026-10-03T17:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      shiftRepo: {
        find: async () => [{
          id: 'shift-c', storeId: 'store-a', status: ShiftStatus.CLOSED,
          openedAt, closedAt, openingNo: 'S-3',
          closing: {revenue: {pressto: {
            revenue: 100.5, discount: 0, taxes: 18.09, totalSales: 119,
          }}},
        }],
      },
      buildStoreContext: async () => new Map(),
      orderRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.createdAt ? [] : [{
            id: 'order-a', storeId: 'store-a', orderType: OrderType.STORE_DROPOFF,
            taxAmount: 18.09, totalAmount: 119,
          }],
      },
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {find: async () => [{
        id: 'invoice-a', orderId: 'order-a', isConsolidated: false,
        subtotal: 100.5, cgst: 9.05, sgst: 9.04, totalAmount: 119,
        createdAt: new Date('2026-10-03T10:00:00Z'),
      }]},
      invoiceOrderLinkRepo: {find: async () => []},
      salesReturnRepo: {find: async () => []},
      storeMonthlyTargetRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildDailySales({storeIds: ['store-a'], from: openedAt, to: closedAt});

    expect(report.rows[0]).to.containEql({revenue: 100.5, taxes: 18.09, totalSales: 119});
  });

  it('keeps migrated z-report tax without counting store invoices twice', async () => {
    const openedAt = new Date('2026-10-04T09:00:00Z');
    const closedAt = new Date('2026-10-04T17:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      shiftRepo: {find: async () => [{
        id: 'shift-d', storeId: 'store-a', status: ShiftStatus.CLOSED,
        openedAt, closedAt, openingNo: 'S-4',
        closing: {
          revenue: {pressto: {revenue: 100, taxes: 18, totalSales: 118}},
          itpv: {zReport: {revenue: {revenue: 100, taxes: 18, totalSales: 118}}},
        },
      }]},
      buildStoreContext: async () => new Map(),
      orderRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.createdAt ? [] : [{
            id: 'order-a', storeId: 'store-a', orderType: OrderType.STORE_DROPOFF,
            taxAmount: 18, totalAmount: 118,
          }],
      },
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {find: async () => [{
        id: 'invoice-a', orderId: 'order-a', isConsolidated: false,
        subtotal: 100, cgst: 9, sgst: 9, totalAmount: 118,
        createdAt: new Date('2026-10-04T10:00:00Z'),
      }]},
      invoiceOrderLinkRepo: {find: async () => []},
      salesReturnRepo: {find: async () => []},
      storeMonthlyTargetRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildDailySales({storeIds: ['store-a'], from: openedAt, to: closedAt});

    expect(report.rows[0]).to.containEql({psbRevenue: 100, revenue: 100, taxes: 18});
  });

  it('does not treat zero-tax return rounding as tax', async () => {
    const openedAt = new Date('2026-10-05T09:00:00Z');
    const closedAt = new Date('2026-10-05T17:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      shiftRepo: {find: async () => [{
        id: 'shift-e', storeId: 'store-a', status: ShiftStatus.CLOSED,
        openedAt, closedAt, openingNo: 'S-5',
        closing: {revenue: {pressto: {revenue: 101, taxes: 0, totalSales: 101}}},
      }]},
      buildStoreContext: async () => new Map(),
      orderRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.createdAt ? [] : [{
            id: 'order-a', storeId: 'store-a', orderType: OrderType.STORE_DROPOFF,
            taxAmount: 0, totalAmount: 0,
          }],
      },
      paymentTransactionRepo: {find: async () => []},
      invoiceRepo: {find: async () => [{
        id: 'invoice-a', orderId: 'order-a', isConsolidated: true,
        subtotal: 101, cgst: 0, sgst: 0, totalAmount: 101,
        createdAt: new Date('2026-10-05T10:00:00Z'),
      }]},
      invoiceOrderLinkRepo: {find: async () => [{
        invoiceId: 'invoice-a', orderId: 'order-a', orderTotal: 0,
      }]},
      salesReturnRepo: {find: async () => [{
        orderId: 'order-a', creditAmount: 101,
        returnedItems: [{amount: 100.5, taxAmount: 0}],
        resolvedAt: new Date('2026-10-06T10:00:00Z'),
      }]},
      storeMonthlyTargetRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildDailySales({storeIds: ['store-a'], from: openedAt, to: closedAt});

    expect(report.rows[0]).to.containEql({psbRevenue: 101, revenue: 101, taxes: 0});
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
      shiftRepo: {find: async () => []},
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
      invoiceNo: 'INV-1',
      amount: 40.25,
    });
    expect(report.totals).to.containEql({amount: 40.25});
  });
});
