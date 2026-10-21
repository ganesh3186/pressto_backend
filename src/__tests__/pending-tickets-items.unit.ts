import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';

describe('pending tickets report items', () => {
  it('returns each item line and its quantity for each ticket page', async () => {
    const orderItems = [
      {id: 'line-1', orderId: 'order-1', itemId: 'shirt', quantity: 2},
      {id: 'line-2', orderId: 'order-1', itemId: 'shirt', quantity: 1},
      {id: 'line-3', orderId: 'order-1', itemId: 'trouser', quantity: 1},
      {id: 'line-4', orderId: 'order-2', itemId: 'coat', quantity: 1},
    ];
    const catalog = [
      {id: 'shirt', name: 'Shirt'},
      {id: 'trouser', name: 'Trouser'},
      {id: 'coat', name: 'Coat'},
    ];
    const catalogQueries: string[][] = [];
    const service = Object.assign(Object.create(ReportsService.prototype), {
      orderRepo: {
        find: async () => [
          {id: 'order-1', storeId: 'store-a', customerId: 'customer-a', totalAmount: 100},
          {id: 'order-2', storeId: 'store-a', customerId: 'customer-a', totalAmount: 50},
        ],
      },
      orderItemRepo: {
        find: async ({where}: {where: {orderId: {inq: string[]}}}) =>
          orderItems.filter(item => where.orderId.inq.includes(item.orderId)),
      },
      itemRepo: {
        find: async ({where}: {where: {id: {inq: string[]}}}) => {
          catalogQueries.push(where.id.inq);
          return catalog.filter(item => where.id.inq.includes(item.id));
        },
      },
      deliveryOrderRepo: {find: async () => []},
      buildStoreContext: async () => new Map(),
      buildCustomerContext: async () => new Map(),
    }) as ReportsService;
    const params = {
      storeIds: ['store-a'],
      from: new Date('2026-10-01'),
      to: new Date('2026-10-31'),
      limit: 1,
    };

    const first = await service.buildPendingTickets({...params, skip: 0});
    const second = await service.buildPendingTickets({...params, skip: 1});

    expect(first.totalCount).to.equal(2);
    expect(first.totals.items).to.equal(5);
    expect(first.rows[0]).to.containEql({
      itemCount: 4,
      items: [
        {name: 'Shirt', quantity: 2},
        {name: 'Shirt', quantity: 1},
        {name: 'Trouser', quantity: 1},
      ],
    });
    expect(second.rows[0]).to.containEql({
      itemCount: 1,
      items: [{name: 'Coat', quantity: 1}],
    });
    expect(catalogQueries).to.deepEqual([['shirt', 'trouser'], ['coat']]);
  });
});
