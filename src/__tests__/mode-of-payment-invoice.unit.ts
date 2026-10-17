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
});
