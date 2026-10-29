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
    }) as CustomerBillingController;

    const result = await controller.billableOrders(customerId, '2026-10-12', '2026-10-12') as {
      billableOrders: Array<{orderId: string; status: OrderStatus}>;
      totalDue: number;
    };

    expect(result.billableOrders.map(order => order.orderId)).to.eql(['on-account', 'partial', 'out', 'legacy']);
    expect(result.billableOrders[0].status).to.equal(OrderStatus.READY);
    expect(result.totalDue).to.equal(205);
  });

  it('allows a processing-complete On Account ticket through invoice eligibility checks', async () => {
    const reachedInvoiceLookup = new Error('reached invoice lookup');
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{id: 'on-account', orderNumber: 'OA-1', status: OrderStatus.READY, isOnAccount: true}]},
      invoiceRepo: {find: async () => {throw reachedInvoiceLookup;}},
      invoiceOrderLinkRepo: {find: async () => []},
    }) as CustomerBillingController;

    let error: unknown;
    try {
      await controller.generateOnAccountInvoice({} as any, customerId, {orderIds: ['on-account']});
    } catch (caught) {
      error = caught;
    }
    expect(error).to.equal(reachedInvoiceLookup);
  });

  it('rejects an On Account invoice while processing is incomplete', async () => {
    const controller = Object.assign(Object.create(CustomerBillingController.prototype), {
      customerRepo: {findOne: async () => ({id: customerId, isOnAccountEligible: true})},
      orderRepo: {find: async () => [{id: 'received', orderNumber: 'OA-0', status: OrderStatus.RECEIVED_AT_STORE, isOnAccount: true}]},
    }) as CustomerBillingController;

    try {
      await controller.generateOnAccountInvoice({} as any, customerId, {orderIds: ['received']});
      throw new Error('Expected the unfinished ticket to be rejected');
    } catch (error) {
      expect((error as {statusCode?: number}).statusCode).to.equal(400);
    }
  });
});
