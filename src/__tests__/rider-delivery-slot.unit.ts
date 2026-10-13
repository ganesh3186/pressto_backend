import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {RiderDeliveryController} from '../controllers/rider-delivery.controller';

describe('rider delivery display fields', () => {
  it('returns slot times and bag numbers in both list and detail responses', async () => {
    const delivery = {
      id: 'delivery-1',
      riderId: 'rider-1',
      bagId: 'bag-1',
      deliverySlotId: 'slot-1',
      deliverySlot: 'Twelfth',
    };
    const legacyDelivery = {
      id: 'delivery-2',
      riderId: 'rider-1',
      deliverySlot: '2:00 PM - 5:00 PM',
    };
    let slotQueries = 0;
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({id: 'rider-1'}),
        deliveryRepository: {
          find: async () => [delivery, legacyDelivery],
          findOne: async () => delivery,
        },
        pickupDeliverySlotRepository: {
          find: async () => {
            slotQueries++;
            return [
              {
                id: 'slot-1',
                label: 'Twelfth',
                startTime: '14:00',
                endTime: '17:30',
              },
            ];
          },
        },
        bagRepository: {find: async () => [{id: 'bag-1', bagNumber: 42}]},
        deliveryOrderRepository: {find: async () => []},
      },
    ) as RiderDeliveryController;

    const list = (await controller.myDeliveries({} as UserProfile)) as {
      deliveries: {deliverySlot: string; bagId?: string; bagNumber: number | null}[];
    };
    const detail = (await controller.deliveryDetail(
      {} as UserProfile,
      'delivery-1',
    )) as {
      delivery: {deliverySlot: string; bagId?: string; bagNumber: number | null};
    };

    expect(list.deliveries.map(d => d.deliverySlot)).to.deepEqual([
      '2:00 PM - 5:30 PM',
      '2:00 PM - 5:00 PM',
    ]);
    expect(detail.delivery.deliverySlot).to.equal('2:00 PM - 5:30 PM');
    expect(list.deliveries.map(d => d.bagNumber)).to.deepEqual([42, null]);
    expect(list.deliveries[0].bagId).to.equal(undefined);
    expect(detail.delivery.bagNumber).to.equal(42);
    expect(detail.delivery.bagId).to.equal(undefined);
    expect(slotQueries).to.equal(2);
  });
});
