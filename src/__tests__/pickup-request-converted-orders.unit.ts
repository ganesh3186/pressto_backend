import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {PickupRequestController} from '../controllers/pickup-request.controller';
import {PickupRequest} from '../models';
import {DeliveryType} from '../models/delivery-type.enum';

describe('pickup request converted orders', () => {
  it('links Lightning, Express and Standard separately and rejects a duplicate tier', async () => {
    const pickup = {
      id: 'pickup-1',
      source: 'web',
      actualItemsByService: [
        {serviceId: 'a', quantity: 1, deliverySpeed: DeliveryType.STANDARD},
        {serviceId: 'b', quantity: 1, deliverySpeed: DeliveryType.LIGHTNING},
        {serviceId: 'c', quantity: 1, deliverySpeed: DeliveryType.EXPRESS},
      ],
    } as PickupRequest;
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      pickupRequestRepository: {
        findOne: async () => pickup,
        updateById: async (_id: string, update: Partial<PickupRequest>) => Object.assign(pickup, update),
      },
      storeScopeService: {resolve: async () => ({global: true})},
      orderRepository: {findOne: async () => ({id: 'order'}), updateById: async () => {}},
    }) as PickupRequestController;

    for (const [speed, id] of [
      [DeliveryType.LIGHTNING, 'order-1'],
      [DeliveryType.EXPRESS, 'order-2'],
      [DeliveryType.STANDARD, 'order-3'],
    ] as const) {
      await controller.updateById({} as UserProfile, pickup.id, {convertedOrderId: id, deliverySpeed: speed});
    }
    expect(pickup.convertedOrderId).to.equal('order-1');
    expect(pickup.convertedOrders).to.deepEqual({lightning: 'order-1', express: 'order-2', standard: 'order-3'});
    await expect(controller.updateById({} as UserProfile, pickup.id, {
      convertedOrderId: 'order-4', deliverySpeed: DeliveryType.STANDARD,
    })).to.be.rejectedWith('This delivery type is not the next order for this pickup request.');

    pickup.convertedOrderId = 'legacy-order';
    pickup.convertedOrders = undefined;
    await controller.updateById({} as UserProfile, pickup.id, {
      convertedOrderId: 'order-2', deliverySpeed: DeliveryType.EXPRESS,
    });
    expect(pickup.convertedOrderId).to.equal('legacy-order');
    expect(pickup.convertedOrders).to.deepEqual({express: 'order-2'});
  });
});
