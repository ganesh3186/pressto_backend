import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';

describe('mode of payment invoice numbers', () => {
  it('shows issued invoice numbers and a dash for tickets without one', async () => {
    const paidAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {
        find: async () => [
          {id: 'order-a', orderNumber: 'T-1', storeId: 'store-a'},
          {id: 'order-b', orderNumber: 'T-2', storeId: 'store-a'},
        ],
      },
      buildWalletTopUpRows: async () => [],
      buildOnAccountInvoiceRows: async () => [],
      shiftRepo: {find: async () => []},
      paymentTransactionRepo: {
        find: async () => [
          {id: 'payment-a', orderId: 'order-a', paymentDate: paidAt, amount: 10, paymentMode: 'cash'},
          {id: 'payment-b', orderId: 'order-b', paymentDate: paidAt, amount: 20, paymentMode: 'cash'},
        ],
      },
      mapOnAccountInvoiceNumbers: async () => new Map(),
      invoiceRepo: {
        find: async ({where}: {where: {status: string}}) => {
          expect(where.status).to.equal('issued');
          return [{orderId: 'order-a', invoiceNumber: 'INV-1'}];
        },
      },
      mapStores: async () => new Map(),
      mapShifts: async () => new Map(),
      mapCustomers: async () => new Map(),
    }) as ReportsService;

    const report = await service.buildModeOfPayment({
      storeIds: ['store-a'],
      from: paidAt,
      to: paidAt,
      limit: 10,
      skip: 0,
    });

    expect(report.rows.map(row => [row.ticketNo, row.invoiceNo])).to.deepEqual([
      ['T-1', 'INV-1'],
      ['T-2', '-'],
    ]);
  });

  it('attributes a cross-store cash refund to the paying shift once', async () => {
    const paidAt = new Date('2026-10-22T10:00:00Z');
    const refund = {
      id: 'refund-a', orderId: 'bandra-order', paymentDate: paidAt,
      amount: 125, paymentMode: 'cash', transactionType: 'refund', cashShiftId: 'shift-012',
    };
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.storeId && !JSON.stringify(where).includes('bandra')
            ? [] : [{id: 'bandra-order', storeId: 'bandra', orderNumber: 'BND-1'}],
      },
      shiftRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          JSON.stringify(where).includes('str012')
            ? [{id: 'shift-012', storeId: 'str012', storeName: 'STR012', closureNo: 4}]
            : [],
      },
      buildWalletTopUpRows: async () => [],
      buildOnAccountInvoiceRows: async () => [],
      paymentTransactionRepo: {find: async () => [refund]},
      mapOnAccountInvoiceNumbers: async () => new Map(),
      invoiceRepo: {find: async () => []},
      mapStores: async () => new Map(),
      mapShifts: async () => new Map(),
      mapCustomers: async () => new Map(),
    }) as ReportsService;

    const payingStore = await service.buildModeOfPayment({
      storeIds: ['str012'], from: paidAt, to: paidAt, limit: 10, skip: 0,
    });
    expect(payingStore.rows).to.have.length(1);
    expect(payingStore.rows[0]).to.containEql({
      storeName: 'STR012', shiftClosureNo: '4', ticketNo: 'BND-1',
      amount: 0, reimbursement: 125,
    });
    expect(payingStore.totals.reimbursement).to.equal(125);

    const ticketStore = await service.buildModeOfPayment({
      storeIds: ['bandra'], from: paidAt, to: paidAt, limit: 10, skip: 0,
    });
    expect(ticketStore.rows).to.have.length(0);
  });
});
