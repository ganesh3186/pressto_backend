/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial LoopBack records. */
import {expect} from '@loopback/testlab';
import {DeliveryType} from '../models/delivery-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderService} from '../services/order.service';

describe('split On Account order', () => {
  it('copies the parent billing choice to the child', async () => {
    for (const isOnAccount of [true, false]) {
      const stopped = new Error('captured child order');
      let child: any;
      const service: any = Object.assign(Object.create(OrderService.prototype), {
        orderRepo: {
          findOne: async () => ({
            id: 'parent',
            customerId: 'customer',
            storeId: 'store',
            orderType: 'store_dropoff',
            status: OrderStatus.READY,
            deliveryType: DeliveryType.STANDARD,
            subtotal: 200,
            totalAmount: 200,
            isOnAccount,
          }),
          create: async (data: any) => {
            child = data;
            throw stopped;
          },
        },
        garmentRepo: {find: async () => [{id: 'garment', orderItemId: 'item', status: GarmentStatus.READY}]},
        orderItemRepo: {find: async () => [{id: 'item', itemId: 'catalog', unitPrice: 100}]},
        garmentAdditionalServiceRepo: {find: async () => []},
        garmentAdditionalChargeRepo: {find: async () => []},
        itemRepo: {find: async () => [{id: 'catalog', isMeasurement: false}]},
        getSplitStandardDays: async () => new Map([['item', 3]]),
        resolveNextOrderNumber: async () => 'CHILD-1',
        paymentTransactionRepo: {find: async () => []},
        dataSource: {beginTransaction: async () => ({rollback: async () => {}})},
      });

      let error: unknown;
      try {
        await service.splitOrder('parent', ['garment'], undefined, undefined, undefined, 'staff');
      } catch (caught) {
        error = caught;
      }

      expect(error).to.equal(stopped);
      expect(child.parentOrderId).to.equal('parent');
      expect(child.isOnAccount).to.equal(isOnAccount);
    }
  });
});
