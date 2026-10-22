import {expect} from '@loopback/testlab';
import {GarmentController} from '../controllers/garment.controller';

describe('garment item context', () => {
  it('uses catalog names when the order item snapshots are blank', async () => {
    const controller = Object.assign(Object.create(GarmentController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}, resolve: async () => ({global: true})},
      orderItemRepository: {
        find: async () => [
          {id: 'order-item-1', orderId: 'order-1', itemId: 'item-1', serviceId: 'service-1', itemName: ' ', serviceName: ''},
        ],
      },
      itemRepository: {find: async () => [{id: 'item-1', name: 'Shirt'}]},
      serviceRepository: {find: async () => [{id: 'service-1', name: 'Wash'}]},
      garmentRepository: {find: async () => [{id: 'garment-1', orderItemId: 'order-item-1'}]},
      damageRepository: {find: async () => []},
      stainRepository: {find: async () => []},
      imageRepository: {find: async () => []},
    }) as GarmentController;

    const result = await controller.listGarments('order-1') as {
      garments: Array<{itemName: string | null; serviceName: string | null}>;
    };
    const [garment] = result.garments;

    expect(garment.itemName).to.equal('Shirt');
    expect(garment.serviceName).to.equal('Wash');
  });
});
