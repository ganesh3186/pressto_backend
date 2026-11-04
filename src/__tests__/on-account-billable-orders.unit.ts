import {expect} from '@loopback/testlab';
import {CustomerBillingController} from '../controllers/customer-billing.controller';
import {OrderStatus} from '../models/order-status.enum';

describe('On Account billable orders', () => {
  const customerId = 'customer-1';
  const createdAt = new Date('2026-10-12T10:39:32.937Z');

  it('lists only processing-complete tickets by order date', async () => {
    const orders = [
      {id: 'received', orderNumber: 'OA-0', status: OrderStatus.RECEIVED_AT_STORE, isOnAccount: true, totalAmount: 100, createdAt},
      {id: 'on-account', orderNumber: 'OA-1', status: OrderStatus.READY, isOnAccount: true, totalAmount: 100, createdAt, deliveryDate: new Date('2026-10-19T10:00:00Z')},
      {id: 'pending-parent', orderNumber: 'OA-P', status: OrderStatus.READY, isOnAccount: true, totalAmount: 75, createdAt},
      {id: 'split-child', orderNumber: 'OA-C', status: OrderStatus.READY, isOnAccount: true, totalAmount: 40, createdAt, parentOrderId: 'pending-parent'},
      {id: 'partial', orderNumber: 'OA-3', status: OrderStatus.PARTIALLY_DISPATCHED, isOnAccount: true, totalAmount: 25, createdAt},
      {id: 'out', orderNumber: 'OA-4', status: OrderStatus.OUT_FOR_DELIVERY, isOnAccount: true, totalAmount: 30, createdAt},
      {id: 'cash', orderNumber: 'C-1', status: OrderStatus.RECEIVED_AT_STORE, isOnAccount: false, totalAmount: 200, createdAt},
      {id: 'draft', orderNumber: 'OA-2', status: OrderStatus.DRAFT, isOnAccount: true, totalAmount: 300, createdAt},
      {id: 'legacy', orderNumber: 'L-1', status: OrderStatus.DELIVERED, isOnAccount: false, totalAmount: 50, createdAt},
    ];
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId})},
      orderRepo: {find: async () => orders},
      invoiceRepo: {find: async () => []},
      invoiceOrderLinkRepo: {find: async () => []},
      paymentRepo: {find: async () => []},
      dataSource: {execute: async () => [{orderid: 'pending-parent'}]},
    }) as CustomerBillingController;

    const result = await controller.billableOrders(customerId, '2026-10-12', '2026-10-12') as {
      billableOrders: Array<{orderId: string; status: OrderStatus}>;
      totalDue: number;
    };

    expect(result.billableOrders.map(order => order.orderId)).to.eql(['on-account', 'split-child', 'partial', 'out', 'legacy']);
    expect(result.billableOrders[0].status).to.equal(OrderStatus.READY);
    expect(result.totalDue).to.equal(245);
  });

  it('allows a processing-complete On Account ticket through invoice eligibility checks', async () => {
    const reachedInvoiceLookup = new Error('reached invoice lookup');
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{id: 'on-account', orderNumber: 'OA-1', status: OrderStatus.READY, isOnAccount: true}]},
      invoiceRepo: {find: async () => {throw reachedInvoiceLookup;}},
      invoiceOrderLinkRepo: {find: async () => []},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
      dataSource: {execute: async () => []},
    }) as CustomerBillingController;

    let error: unknown;
    try {
      await controller.generateOnAccountInvoice(
        {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
        customerId,
        {orderIds: ['on-account']},
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).to.equal(reachedInvoiceLookup);
  });

  it('rejects an On Account invoice while processing is incomplete', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{id: 'received', orderNumber: 'OA-0', status: OrderStatus.RECEIVED_AT_STORE, isOnAccount: true}]},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
    }) as CustomerBillingController;

    try {
      await controller.generateOnAccountInvoice(
        {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
        customerId,
        {orderIds: ['received']},
      );
      throw new Error('Expected the unfinished ticket to be rejected');
    } catch (error) {
      expect((error as {statusCode?: number}).statusCode).to.equal(400);
    }
  });

  it('rejects invoice generation while a selected ticket has pending damage approval', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{id: 'pending-parent', orderNumber: 'OA-P', status: OrderStatus.READY, isOnAccount: true}]},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
      dataSource: {execute: async () => [{orderid: 'pending-parent'}]},
    }) as CustomerBillingController;

    await expect(controller.generateOnAccountInvoice(
      {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
      customerId,
      {orderIds: ['pending-parent']},
    ))
      .to.be.rejectedWith(/Resolve pending damage approval before billing/);
  });

  it('rejects a consolidated invoice containing tickets from different stores', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [
        {id: 'order-a', storeId: 'store-a', status: OrderStatus.READY, isOnAccount: true},
        {id: 'order-b', storeId: 'store-b', status: OrderStatus.READY, isOnAccount: true},
      ]},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
    }) as CustomerBillingController;

    await expect(controller.generateOnAccountInvoice(
      {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
      customerId,
      {orderIds: ['order-a', 'order-b']},
    )).to.be.rejectedWith(/only contain orders from one store/);
  });

  it('hides selected tickets outside the caller store scope', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [
        {id: 'order-b', storeId: 'store-b', status: OrderStatus.READY, isOnAccount: true},
      ]},
      storeScopeService: {
        resolve: async () => ({global: false, storeIds: ['store-a']}),
        allows: (_scope: unknown, storeId: string) => storeId === 'store-a',
      },
    }) as CustomerBillingController;

    await expect(controller.generateOnAccountInvoice(
      {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
      customerId,
      {orderIds: ['order-b']},
    )).to.be.rejectedWith(/not found for this customer/);
  });

  it('rechecks existing invoices after locking selected tickets', async () => {
    const tx = {commit: async () => undefined, rollback: async () => undefined};
    let invoiceLookups = 0;
    let locked = false;
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{
        id: 'order-a', storeId: 'store-a', orderNumber: 'OA-1', status: OrderStatus.READY,
        isOnAccount: true, totalAmount: 100, taxAmount: 10,
      }]},
      storeScopeService: {resolve: async () => ({global: true}), allows: () => true},
      invoiceRepo: {find: async () => {
        invoiceLookups += 1;
        return invoiceLookups === 1 ? [] : [{orderId: 'order-a'}];
      }},
      invoiceOrderLinkRepo: {find: async () => []},
      paymentRepo: {find: async () => []},
      onAccountConfigRepo: {findOne: async () => ({defaultInvoiceSpanDays: 30})},
      dataSource: {
        execute: async (sql: string) => {
          if (sql.includes('FOR UPDATE')) locked = true;
          return [];
        },
        beginTransaction: async () => tx,
      },
    }) as CustomerBillingController;

    await expect(controller.generateOnAccountInvoice(
      {} as Parameters<CustomerBillingController['generateOnAccountInvoice']>[0],
      customerId,
      {orderIds: ['order-a']},
    )).to.be.rejectedWith(/already invoiced/);
    expect(locked).to.be.true();
    expect(invoiceLookups).to.equal(2);
  });

  it('hides consolidated invoice details outside the caller store scope', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      invoiceRepo: {findById: async () => ({id: 'invoice-b', orderId: 'order-b'})},
      invoiceOrderLinkRepo: {find: async () => []},
      orderRepo: {find: async () => [{id: 'order-b', storeId: 'store-b'}]},
      storeScopeService: {
        resolve: async () => ({global: false, storeIds: ['store-a']}),
        allows: (_scope: unknown, storeId: string) => storeId === 'store-a',
      },
    }) as CustomerBillingController;

    await expect(controller.consolidatedInvoiceOrders(
      {} as Parameters<CustomerBillingController['consolidatedInvoiceOrders']>[0],
      'invoice-b',
    )).to.be.rejectedWith(/Invoice not found/);
  });

  it('returns on-account history only for orders in the caller store scope', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId})},
      orderRepo: {find: async () => [
        {id: 'order-a', storeId: 'store-a'},
        {id: 'order-b', storeId: 'store-b'},
      ]},
      invoiceRepo: {find: async ({where}: {where: {orderId: {inq: string[]}}}) => {
        expect(where.orderId.inq).to.eql(['order-a']);
        return [{id: 'invoice-a', invoiceNumber: 'OA-1'}];
      }},
      invoiceOrderLinkRepo: {find: async () => []},
      storeScopeService: {
        resolve: async () => ({global: false, storeIds: ['store-a']}),
        allows: (_scope: unknown, storeId: string) => storeId === 'store-a',
      },
    }) as CustomerBillingController;

    const result = await controller.onAccountInvoiceHistory(
      {} as Parameters<CustomerBillingController['onAccountInvoiceHistory']>[0],
      customerId,
    ) as {invoices: Array<{invoiceNumber: string}>};
    expect(result.invoices.map(invoice => invoice.invoiceNumber)).to.eql(['OA-1']);
  });

  it('hides legacy invoice history when any linked order is outside the caller store scope', async () => {
    let orderLookup = 0;
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId})},
      orderRepo: {find: async () => {
        orderLookup += 1;
        return orderLookup === 1
          ? [{id: 'order-a', storeId: 'store-a'}]
          : [{id: 'order-a', storeId: 'store-a'}, {id: 'order-b', storeId: 'store-b'}];
      }},
      invoiceRepo: {find: async () => [{id: 'legacy-invoice', invoiceNumber: 'OA-OLD'}]},
      invoiceOrderLinkRepo: {find: async () => [
        {invoiceId: 'legacy-invoice', orderId: 'order-a'},
        {invoiceId: 'legacy-invoice', orderId: 'order-b'},
      ]},
      storeScopeService: {
        resolve: async () => ({global: false, storeIds: ['store-a']}),
        allows: (_scope: unknown, storeId: string) => storeId === 'store-a',
      },
    }) as CustomerBillingController;

    const result = await controller.onAccountInvoiceHistory(
      {} as Parameters<CustomerBillingController['onAccountInvoiceHistory']>[0],
      customerId,
    ) as {invoices: unknown[]};
    expect(result.invoices).to.be.empty();
  });
});
