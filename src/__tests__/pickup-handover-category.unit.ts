import {expect} from '@loopback/testlab';
import {PickupHandoverController} from '../controllers/pickup-handover.controller';
import {PickupHandoverStatus} from '../models/pickup-handover-status.enum';

describe('pickup handover category labels', () => {
  it('shows only assigned categories in pending and confirmed lists', async () => {
    const controller = Object.assign(Object.create(PickupHandoverController.prototype), {
      handoverRepo: {
        find: async () => [{id: 'handover-1'}],
        findOne: async () => ({id: 'handover-1', handoverToType: 'store'}),
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
        {id: 'pickup-2', actualItemsByService: [
          {serviceId: 'service-2', quantity: 2},
          {serviceId: 'service-4', quantity: 5},
        ], itemCategoryEstimate: [
          {itemCategoryId: 'item-category-2', serviceId: 'service-2', quantity: 2},
          {itemCategoryId: 'item-category-4', serviceId: 'service-4', quantity: 5},
        ]},
        {id: 'pickup-3', actualItemsByService: [
          {serviceId: 'service-3', serviceName: 'Clean', quantity: 5},
          {serviceId: 'service-5', serviceName: 'Press at pickup', quantity: 5},
        ], itemCategoryEstimate: [
          {itemCategoryId: 'item-category-3', itemCategoryName: 'Pressto Special service',
            serviceId: 'service-3', serviceName: 'Clean', quantity: 5},
          {itemCategoryId: 'item-category-2', serviceId: 'service-5', quantity: 5},
        ]},
      ]},
      bagRepo: {find: async () => []},
      mediaRepo: {find: async () => []},
      serviceRepo: {find: async () => [
        {id: 'service-2', name: 'Carpet Clean', serviceCategoryId: 'category-2'},
        {id: 'service-3', name: 'Clean after rename', serviceCategoryId: 'category-3'},
        {id: 'service-4', name: 'PSB Clean', serviceCategoryId: 'category-2'},
        {id: 'service-5', name: 'Press', serviceCategoryId: 'category-3'},
      ]},
      itemCategoryRepo: {find: async () => [
        {id: 'item-category-2', name: 'Carpet'},
        {id: 'item-category-3', name: 'Special service after rename'},
        {id: 'item-category-4', name: 'PSB'},
      ]},
      serviceCategoryRepo: {find: async () => [
        {id: 'category-2', name: 'Shoes & Bags (PSBO)'},
        {id: 'category-3', name: 'Garments (PDC)'},
      ]},
    }) as PickupHandoverController;

    for (const status of [PickupHandoverStatus.PENDING, PickupHandoverStatus.CONFIRMED]) {
      const result = await controller.find(status) as {
        handovers: Array<{items: Array<{
          actualItemsByService: Array<{serviceCategoryName: string | null; serviceName: string | null}>;
          itemCategoryEstimate: Array<{serviceCategoryName: string | null; itemCategoryName: string | null; serviceName: string | null}>;
        }>}>};
      const [missing, known, pdc] = result.handovers[0].items;
      expect(missing.actualItemsByService[0].serviceCategoryName).to.equal(null);
      expect(missing.itemCategoryEstimate[0].serviceCategoryName).to.equal(null);
      expect(known.actualItemsByService[0].serviceCategoryName).to.equal('Shoes & Bags (PSBO)');
      expect(known.actualItemsByService.map(line => line.serviceName)).to.deepEqual(['Carpet Clean', 'PSB Clean']);
      expect(known.itemCategoryEstimate.map(line => [line.serviceName, line.itemCategoryName])).to.deepEqual([
        ['Carpet Clean', 'Carpet'],
        ['PSB Clean', 'PSB'],
      ]);
      expect(pdc.actualItemsByService[0].serviceCategoryName).to.equal('Garments (PDC)');
      expect(pdc.actualItemsByService.map(line => line.serviceName)).to.deepEqual(['Clean', 'Press at pickup']);
      expect(pdc.itemCategoryEstimate.map(line => [line.serviceName, line.itemCategoryName])).to.deepEqual([
        ['Clean', 'Pressto Special service'],
        ['Press', 'Carpet'],
      ]);
    }

    const scanned = await controller.lookup('handover-code') as {
      items: Array<{itemCategoryEstimate: Array<{serviceName: string | null; itemCategoryName: string | null}>}>;
    };
    expect(scanned.items[2].itemCategoryEstimate.map(line => [line.serviceName, line.itemCategoryName])).to.deepEqual([
      ['Clean', 'Pressto Special service'],
      ['Press', 'Carpet'],
    ]);
  });
});
