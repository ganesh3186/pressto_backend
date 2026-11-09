/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

const ORDER = {id: 'order-1', orderNumber: 'ORD1', customerId: 'customer-1', storeId: 'store-1',
  orderType: 'store_dropoff', status: 'received_at_store', totalAmount: 100, isDeleted: false,
  reprocessOfOrderId: 'order-0'};
const TX = {transaction: {id: 'tx-1'}};

function service(overrides: Record<string, any>, calls: any[] = []) {
  const emptyRepo: any = {find: async () => [], findOne: async () => null, findById: async () => null,
    count: async () => ({count: 0})};
  const base = Object.create(OrderService.prototype);
  return new Proxy(base, {
    get(target, key: string) {
      if (key in overrides) return overrides[key];
      if (key in target) return target[key];
      if (key.endsWith('Repo') || key.endsWith('Repository')) {
        return new Proxy(emptyRepo, {get: (repo: any, method: string) => async (...args: any[]) => {
          calls.push({key, method, args});
          return repo[method] ? repo[method]() : null;
        }});
      }
      return async () => null;
    },
  }) as OrderService;
}

// An order still being created is only visible on its own transaction.
const uncommittedOrderRepo = {
  findOne: async (_filter: unknown, options?: {transaction?: unknown}) => (options?.transaction ? ORDER : null),
  find: async () => [],
};
const orderItems = {find: async () => [{id: 'item-1', orderId: 'order-1', serviceId: 's1', itemId: 'i1', quantity: 1}]};

describe('order details inside a transaction', () => {
  it('finds an order that is not committed yet when given the transaction', async () => {
    const result: any = await service({orderRepo: uncommittedOrderRepo}).getOrderDetails('order-1', TX);
    expect(result.order.id).to.equal('order-1');
  });

  it('cannot see that order without the transaction', async () => {
    await expect(service({orderRepo: uncommittedOrderRepo}).getOrderDetails('order-1'))
      .to.be.rejectedWith(/Order not found/);
  });

  it('runs every database read on the transaction', async () => {
    const calls: any[] = [];
    await service({
      orderRepo: {findOne: async () => ORDER, find: async () => []},
      orderItemRepo: orderItems,
    }, calls).getOrderDetails('order-1', TX);

    expect(calls.length).to.be.above(5);
    expect(calls.filter(call => call.args[call.args.length - 1] !== TX).map(call => `${call.key}.${call.method}`))
      .to.deepEqual([]);
  });

  it('does not look up a user id that is not a UUID', async () => {
    const lookedUp: string[] = [];
    await service({
      orderRepo: {findOne: async () => ORDER, find: async () => []},
      statusHistoryRepo: {find: async () => [{changedBy: 'system'}]},
      userRepo: {findById: async (id: string) => { lookedUp.push(id); return null; }, findOne: async () => null},
    }).getOrderDetails('order-1', TX);

    expect(lookedUp).to.deepEqual([]);
  });

  it('generates the invoice snapshot on the caller transaction', async () => {
    const tx = {commit: async () => {}, rollback: async () => {}};
    let detailsOptions: any;
    await service({
      dataSource: {execute: async () => []},
      orderRepo: {findOne: async () => ORDER},
      invoiceRepo: {
        findOne: async () => null,
        create: async (invoice: object) => invoice,
        findById: async () => ({}),
      },
      orderItemRepo: {find: async () => []},
      computeBalanceDue: async () => ({due: 0, alreadyPaid: 100}),
      allocateInvoiceNumber: async () => 'INV-1',
      getOrderDetails: async (_id: string, options: unknown) => {
        detailsOptions = options;
        return {items: []};
      },
    }).generateInvoiceForOrder('order-1', '00000000-0000-4000-8000-000000000001', true, tx as never);

    expect(detailsOptions?.transaction).to.equal(tx);
  });
});
