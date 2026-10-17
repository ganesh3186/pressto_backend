import {expect} from '@loopback/testlab';
import {PickupHandoverController} from '../controllers/pickup-handover.controller';
import {PickupHandoverStatus} from '../models/pickup-handover-status.enum';

describe('pickup handover category labels', () => {
  it('shows only assigned categories in pending and confirmed lists', async () => {
    const controller = Object.assign(Object.create(PickupHandoverController.prototype), {
      handoverRepo: {
        find: async () => [{id: 'handover-1'}],
        count: async () => ({count: 1}),
      },
      handoverItemRepo: {find: async () => [
        {id: 'item-1', pickupHandoverId: 'handover-1', pickupRequestId: 'pickup-1'},
        {id: 'item-2', pickupHandoverId: 'handover-1', pickupRequestId: 'pickup-2'},
        {id: 'item-3', pickupHandoverId: 'handover-1', pickupRequestId: 'pickup-3'},
      ]},
      pickupRequestRepo: {find: async () => [
        {id: 'pickup-1', actualItemsByService: [{serviceId: 'missing-service', quantity: 1}],
          itemCategoryEstimate: [{itemCategoryId: 'category-1', quantity: 1}]},
        {id: 'pickup-2', actualItemsByService: [{serviceId: 'service-2', quantity: 2}],
          itemCategoryEstimate: [{itemCategoryId: 'category-2', quantity: 2}]},
        {id: 'pickup-3', actualItemsByService: [{serviceId: 'service-3', quantity: 1}],
          itemCategoryEstimate: [{itemCategoryId: 'category-3', quantity: 1}]},
      ]},
      bagRepo: {find: async () => []},
      mediaRepo: {find: async () => []},
      serviceRepo: {find: async () => [
        {id: 'service-2', serviceCategoryId: 'category-2'},
        {id: 'service-3', serviceCategoryId: 'category-3'},
      ]},
      serviceCategoryRepo: {find: async () => [
        {id: 'category-2', name: 'Shoes & Bags (PSBO)'},
        {id: 'category-3', name: 'Garments (PDC)'},
      ]},
    }) as PickupHandoverController;

    for (const status of [PickupHandoverStatus.PENDING, PickupHandoverStatus.CONFIRMED]) {
      const result = await controller.find(status) as {
        handovers: Array<{items: Array<{
          actualItemsByService: Array<{serviceCategoryName: string | null}>;
          itemCategoryEstimate: Array<{serviceCategoryName: string | null}>;
        }>}>};
      const [missing, known, pdc] = result.handovers[0].items;
      expect(missing.actualItemsByService[0].serviceCategoryName).to.equal(null);
      expect(missing.itemCategoryEstimate[0].serviceCategoryName).to.equal(null);
      expect(known.actualItemsByService[0].serviceCategoryName).to.equal('Shoes & Bags (PSBO)');
      expect(known.itemCategoryEstimate[0].serviceCategoryName).to.equal('Shoes & Bags (PSBO)');
      expect(pdc.actualItemsByService[0].serviceCategoryName).to.equal('Garments (PDC)');
      expect(pdc.itemCategoryEstimate[0].serviceCategoryName).to.equal('Garments (PDC)');
    }
  });
});
