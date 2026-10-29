/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial LoopBack records. */
import {expect} from '@loopback/testlab';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderService} from '../services/order.service';

describe('order delivery garment status', () => {
  it('delivers active garments when the ticket is marked delivered', async () => {
    const garments = [
      {id: 'ready', status: GarmentStatus.READY},
      {id: 'returned', status: GarmentStatus.RETURNED_TO_CUSTOMER},
    ];
    const histories: Array<{garmentId: string; status: GarmentStatus}> = [];
    let committed = false;
    const tx = {commit: async () => { committed = true; }, rollback: async () => undefined};
    const service: any = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => undefined},
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: OrderStatus.READY}),
        updateById: async (_id: string, _patch: object, options: {transaction: object}) => {
          expect(options.transaction).to.equal(tx);
        },
      },
      deliveryOrderRepo: {find: async () => []},
      statusHistoryRepo: {create: async (_entry: object, options: {transaction: object}) => {
        expect(options.transaction).to.equal(tx);
      }},
      orderItemRepo: {find: async () => [{id: 'item-1'}]},
      garmentRepo: {
        find: async () => garments,
        updateById: async (id: string, patch: {status: GarmentStatus}, options: {transaction: object}) => {
          expect(options.transaction).to.equal(tx);
          Object.assign(garments.find(g => g.id === id)!, patch);
        },
      },
      garmentStatusHistoryRepo: {
        create: async (entry: {garmentId: string; status: GarmentStatus}, options: {transaction: object}) => {
          expect(options.transaction).to.equal(tx);
          histories.push(entry);
        },
      },
      notifyStatusChange: () => undefined,
    });

    await service.changeStatus('order-1', OrderStatus.DELIVERED, 'user-1');

    expect(garments.map(g => g.status)).to.deepEqual([
      GarmentStatus.DELIVERED,
      GarmentStatus.RETURNED_TO_CUSTOMER,
    ]);
    expect(histories.map(h => h.garmentId)).to.deepEqual(['ready']);
    expect(committed).to.be.true();
  });

  it('rolls back the ticket when a garment cannot be delivered', async () => {
    let committed = false;
    let rolledBack = false;
    const tx = {
      commit: async () => { committed = true; },
      rollback: async () => { rolledBack = true; },
    };
    const service: any = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => undefined},
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: OrderStatus.READY}),
        updateById: async (_id: string, _patch: object, options: {transaction: object}) => {
          expect(options.transaction).to.equal(tx);
        },
      },
      deliveryOrderRepo: {find: async () => []},
      statusHistoryRepo: {create: async () => undefined},
      orderItemRepo: {find: async () => [{id: 'item-1'}]},
      garmentRepo: {
        find: async () => [{id: 'ready', status: GarmentStatus.READY}],
        updateById: async () => { throw new Error('Garment write failed'); },
      },
    });

    await expect(service.changeStatus('order-1', OrderStatus.DELIVERED, 'user-1'))
      .to.be.rejectedWith('Garment write failed');
    expect(rolledBack).to.be.true();
    expect(committed).to.be.false();
  });

  it('delivers active garments without erasing damaged, held, or returned statuses', async () => {
    const garments = [
      {id: 'ready', status: GarmentStatus.READY},
      {id: 'damaged', status: GarmentStatus.DAMAGED},
      {id: 'held', status: GarmentStatus.ON_HOLD},
      {id: 'returned', status: GarmentStatus.RETURNED_TO_CUSTOMER},
      {id: 'delivered', status: GarmentStatus.DELIVERED},
    ];
    const histories: Array<{garmentId: string; status: GarmentStatus}> = [];
    const service: any = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [{id: 'item-1'}]},
      garmentRepo: {
        find: async () => garments,
        updateById: async (id: string, patch: {status: GarmentStatus}) => {
          Object.assign(garments.find(g => g.id === id)!, patch);
        },
      },
      garmentStatusHistoryRepo: {
        create: async (entry: {garmentId: string; status: GarmentStatus}) => {
          histories.push(entry);
        },
      },
    });

    const count = await service._cascadeGarmentsToDelivered('order-1', 'user-1', () => 'history-1');

    expect(count).to.equal(1);
    expect(garments.map(g => g.status)).to.deepEqual([
      GarmentStatus.DELIVERED,
      GarmentStatus.DAMAGED,
      GarmentStatus.ON_HOLD,
      GarmentStatus.RETURNED_TO_CUSTOMER,
      GarmentStatus.DELIVERED,
    ]);
    expect(histories.map(h => h.garmentId)).to.deepEqual(['ready']);
  });
});
