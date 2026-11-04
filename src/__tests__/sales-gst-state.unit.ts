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
        find: async () => [{id: 'invoice-x', orderId: 'order-x'}],
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

  it('returns one row per invoice item with the customer GST number', async () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      invoiceRepo: {find: async () => [{
        id: 'invoice-a', invoiceNumber: 'INV-100', orderId: 'order-a', createdAt,
        subtotal: 1000.25, discount: 100, cgst: 45.03, sgst: 45.02, totalAmount: 990,
        items: [{itemId: 'item-shirt', totalPrice: 400}, {itemId: 'item-trouser', totalPrice: 600}],
      }]},
      orderRepo: {find: async () => [{
        id: 'order-a', orderNumber: 'T-100', storeId: 'store-a', customerId: 'customer-a',
      }]},
      gstTaxConfigurationRepo: {findOne: async () => ({cgstPercentage: 5, sgstPercentage: 5})},
      buildStoreContext: async () => new Map([['store-a', {
        name: 'Store A', code: 'STR-A', state: 'Maharashtra',
      }]]),
      customerRepo: {find: async () => [{
        id: 'customer-a', firstName: 'Customer', gstNumber: '27ABCDE1234F1Z5',
        customerEntityType: 'individual',
      }]},
      itemRepo: {find: async () => [
        {id: 'item-shirt', name: 'Shirt'},
        {id: 'item-trouser', name: 'Trouser'},
      ]},
      customerAddressRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildSalesGst({
      storeIds: ['store-a'], from: createdAt, to: createdAt, limit: 25, skip: 0,
    });

    expect(report.totalCount).to.equal(2);
    expect(report.rows[0]).to.containEql({
      id: 'invoice-a-0', invoiceNo: 'INV-100', invoiceDate: createdAt,
      isFirstItem: true, invoiceValue: 990, taxableValue: 900.25, totalTax: 90.05,
      customerGstin: '27ABCDE1234F1Z5',
      itemName: 'Shirt', description: 'Shirt',
    });
    expect(report.rows[1]).to.containEql({
      id: 'invoice-a-1', invoiceNo: 'INV-100', invoiceDate: createdAt,
      isFirstItem: false, invoiceValue: 0, taxableValue: 0, totalTax: 0,
      customerGstin: '27ABCDE1234F1Z5',
      itemName: 'Trouser', description: 'Trouser',
    });
    expect(report.rows[0]).not.to.have.property('ticketNo');
    expect(report.totals).to.containEql({invoiceValue: 990, taxableValue: 900.25, totalTax: 90.05});
  });

  it('keeps legacy consolidated GST at its invoice-time value after a return', async () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      invoiceRepo: {find: async () => [{
        id: 'legacy-invoice', invoiceNumber: 'OA-1', orderId: 'order-a', createdAt,
        subtotal: 55, totalAmount: 55, isConsolidated: true, cgst: 0, sgst: 0,
      }]},
      invoiceOrderLinkRepo: {find: async () => [{
        invoiceId: 'legacy-invoice', orderId: 'order-a', orderTotal: 55,
      }]},
      orderRepo: {find: async ({where}: {where: {storeId?: unknown}}) => where.storeId
        ? [{id: 'order-a', storeId: 'store-a', customerId: 'customer-a'}]
        : [{id: 'order-a', storeId: 'store-a', subtotal: 27.27, discountAmount: 0, taxAmount: 2.73, totalAmount: 30}]},
      salesReturnRepo: {find: async () => [{
        orderId: 'order-a', creditAmount: 80, resolvedAt: new Date('2026-10-02T10:00:00Z'),
        returnedItems: [{amount: 72.73, taxAmount: 7.27}],
      }]},
      paymentTransactionRepo: {find: async () => [{
        orderId: 'order-a', amount: 55, paymentDate: new Date('2026-09-30T10:00:00Z'),
      }]},
      gstTaxConfigurationRepo: {findOne: async () => ({cgstPercentage: 5, sgstPercentage: 5})},
      buildStoreContext: async () => new Map([['store-a', {name: 'Store A'}]]),
      customerRepo: {find: async () => [{id: 'customer-a', firstName: 'Customer'}]},
      orderItemRepo: {find: async () => []},
      itemRepo: {find: async () => []},
      customerAddressRepo: {find: async () => []},
    }) as ReportsService;

    const report = await service.buildSalesGst({
      storeIds: ['store-a'], from: createdAt, to: createdAt, limit: 25, skip: 0,
    });

    expect(report.rows[0]).to.containEql({
      invoiceNo: 'OA-1', invoiceValue: 55, taxableValue: 50,
      cgstAmount: 2.5, sgstAmount: 2.5, totalTax: 5,
    });
  });

  it('does not expose a cross-store consolidated invoice to one store', async () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      invoiceRepo: {find: async () => [{
        id: 'cross-store', orderId: 'order-a', createdAt, isConsolidated: true,
      }]},
      invoiceOrderLinkRepo: {find: async () => [
        {invoiceId: 'cross-store', orderId: 'order-a', orderTotal: 100},
        {invoiceId: 'cross-store', orderId: 'order-b', orderTotal: 100},
      ]},
      orderRepo: {find: async () => [
        {id: 'order-a', storeId: 'store-a'},
        {id: 'order-b', storeId: 'store-b'},
      ]},
    }) as ReportsService;

    const report = await service.buildSalesGst({
      storeIds: ['store-a'], from: createdAt, to: createdAt, limit: 25, skip: 0,
    });

    expect(report.totalCount).to.equal(0);
  });
});
