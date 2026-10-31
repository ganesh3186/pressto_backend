import {expect} from '@loopback/testlab';
import {PickupRequestService} from '../services/pickup-request.service';

describe('pickup request name snapshots', () => {
  it('saves the selected service and item category names at creation', async () => {
    let saved: {itemCategoryEstimate?: unknown[]} = {};
    const service = Object.assign(Object.create(PickupRequestService.prototype), {
      pickupRepository: {create: async (data: typeof saved) => {saved = data; return data;}},
      itemCategoryRepository: {find: async () => [{id: 'item-category-1', name: 'Pressto Special service'}]},
      serviceCategoryRepository: {find: async () => [{id: 'legacy-category', name: 'Garments (PDC)'}]},
      serviceRepository: {find: async () => [{id: 'service-1', name: 'Clean'}]},
      whatsAppService: {notifyPickup: async () => {}},
    }) as PickupRequestService;

    await service.createRequest({id: 'pickup-1', itemCategoryEstimate: [
      {itemCategoryId: 'item-category-1', serviceId: 'service-1', quantity: 5},
      {itemCategoryId: 'legacy-category', serviceId: 'service-1', quantity: 1},
    ]} as Parameters<PickupRequestService['createRequest']>[0]);

    expect(saved.itemCategoryEstimate).to.containDeep([
      {itemCategoryName: 'Pressto Special service', serviceName: 'Clean'},
      {itemCategoryName: 'Garments (PDC)', serviceName: 'Clean'},
    ]);
  });
});
