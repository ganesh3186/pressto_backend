/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial LoopBack records. */
import {expect} from '@loopback/testlab';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderService} from '../services/order.service';

describe('in-store handover garment status', () => {
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
