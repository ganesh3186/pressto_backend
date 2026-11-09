/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

const ORDER = {id: 'order-1', orderNumber: 'ORD1', customerId: 'customer-1', storeId: 'store-1',
  orderType: 'home_pickup', pickupRequestId: 'pickup-1', status: 'out_for_delivery', totalAmount: 100,
  isDeleted: false};

// Any repository not listed returns nothing, so only the remark sources matter.
function service(overrides: Record<string, any>, calls: any[] = []) {
  const emptyRepo = {find: async () => [], findOne: async () => null, findById: async () => null,
    count: async () => ({count: 0})};
  const base = Object.create(OrderService.prototype);
  return new Proxy(base, {
    get(target, key: string) {
      if (key in overrides) return overrides[key];
      if (key in target) return target[key];
      if (key === 'dataSource') return {execute: async () => []};
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

describe('ticket details remarks', () => {
  it('returns the booking and rider pickup remarks, and failed delivery remarks newest first', async () => {
    let deliveryWhere: any;
    const result: any = await service({
      orderRepo: {findOne: async () => ORDER, find: async () => [], findById: async () => ORDER},
      pickupRequestRepo: {findOne: async () => ({
        id: 'pickup-1', assignedRiderName: 'Ravi', remarks: ' Call before coming ',
        actualItemsByService: [
          {serviceId: 's1', serviceName: 'Dry Clean', quantity: 2, remarks: 'Stain on white shirt'},
          {serviceId: 's2', serviceName: 'Laundry', quantity: 3, remarks: '  '},
        ],
      })},
      deliveryOrderRepo: {find: async (filter: any) => {
        deliveryWhere = filter;
        return [
          {failureRemarks: 'Customer not home', updatedAt: new Date('2026-11-05T10:00:00Z')},
          {failureRemarks: '', updatedAt: new Date('2026-11-04T10:00:00Z')},
        ];
      }},
    }).getOrderDetails('order-1');

    expect(result.order.pickupRemarks).to.deepEqual([
      {source: 'booking', remarks: 'Call before coming'},
      {source: 'rider', serviceName: 'Dry Clean', remarks: 'Stain on white shirt'},
    ]);
    expect(result.order.deliveryAttemptRemarks).to.deepEqual([
      {remarks: 'Customer not home', at: new Date('2026-11-05T10:00:00Z')},
    ]);
    expect(deliveryWhere.where).to.containEql({orderId: 'order-1'});
    expect(deliveryWhere.order).to.deepEqual(['updatedAt DESC']);
  });

  it('leaves out pickup remarks on a counter ticket', async () => {
    const counter = {...ORDER, orderType: 'store_dropoff', pickupRequestId: undefined};
    const result: any = await service({
      orderRepo: {findOne: async () => counter, find: async () => [], findById: async () => counter},
    }).getOrderDetails('order-1');
    expect(result.order).to.not.have.property('pickupRemarks');
    expect(result.order.deliveryAttemptRemarks).to.deepEqual([]);
  });
});
