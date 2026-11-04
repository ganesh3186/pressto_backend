import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';

describe('mode of payment invoice numbers', () => {
  it('keeps the ticket number separate from the on-account invoice number', async () => {
    const paidAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {
        find: async () => [
          {id: 'order-a', orderNumber: 'T-1', storeId: 'store-a'},
          {id: 'order-b', orderNumber: 'T-2', storeId: 'store-a'},
        ],
      },
      buildWalletTopUpRows: async () => [],
      shiftRepo: {find: async () => []},
      paymentTransactionRepo: {
        find: async () => [
          {id: 'payment-a', orderId: 'order-a', paymentDate: paidAt, amount: 10, paymentMode: 'cash'},
          {id: 'payment-b', orderId: 'order-b', paymentDate: paidAt, amount: 20, paymentMode: 'cash'},
        ],
      },
      mapOnAccountInvoiceNumbers: async () => new Map([['order-a', 'OA-INV-1']]),
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
      ['T-1', 'OA-INV-1'],
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

  it('counts only real payments in the on-account billing report', async () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {find: async () => [{
        id: 'order-a', orderNumber: 'OA-1', storeId: 'store-a', customerId: 'customer-a',
        totalAmount: 100, status: 'delivered', isOnAccount: true, createdAt,
      }]},
      paymentTransactionRepo: {find: async () => [{orderId: 'order-a', amount: 40}]},
      buildDeliveryStatusByOrder: async () => new Map([['order-a', 'delivered']]),
      buildDeliveredAtByOrder: async () => new Map([['order-a', createdAt]]),
      buildItemCountByOrder: async () => new Map([['order-a', 1]]),
      buildStoreContext: async () => new Map([['store-a', {name: 'Store A'}]]),
      buildCustomerContext: async () => new Map([['customer-a', {name: 'Customer A'}]]),
    }) as ReportsService;

    const report = await service.buildOnAccountBilling({
      storeIds: ['store-a'], from: createdAt, to: createdAt, limit: 10, skip: 0,
      deliveryStatus: 'all', paymentStatus: 'all',
    });

    expect(report.rows[0]).to.containEql({collected: 40, balanceDue: 60});
    expect(report.totals).to.containEql({collected: 40, balanceDue: 60});
  });

  it('includes in-store wallet recharges under their cash, card, and UPI modes', async () => {
    const paidAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      walletRechargeRequestRepo: {find: async () => [
        {id: 'cash', customerId: 'customer-a', storeId: 'store-a', amount: 100, paymentMode: 'cash', createdAt: paidAt},
        {id: 'card', customerId: 'customer-a', storeId: 'store-a', amount: 200, paymentMode: 'card', createdAt: paidAt},
        {id: 'upi', customerId: 'customer-a', storeId: 'store-a', amount: 300, paymentMode: 'upi', createdAt: paidAt},
      ]},
      customerRepo: {find: async () => [{id: 'customer-a', firstName: 'Customer'}]},
      storeRepo: {find: async () => [{id: 'store-a', name: 'Store A'}]},
      shiftRepo: {find: async () => []},
      paymentTransactionRepo: {find: async () => []},
      orderRepo: {find: async () => []},
      mapOnAccountInvoiceNumbers: async () => new Map(),
      invoiceRepo: {find: async () => []},
      mapStores: async () => new Map(),
      mapShifts: async () => new Map(),
      mapCustomers: async () => new Map(),
    }) as ReportsService;

    const report = await service.buildModeOfPayment({
      storeIds: ['store-a'], from: paidAt, to: paidAt, limit: 10, skip: 0,
    });

    expect(report.rows).to.have.length(3);
    expect(report.totals).to.containEql({amount: 600});
    expect(report.totalsByMode).to.containEql({Cash: 100, Card: 200, UPI: 300});
  });
});
