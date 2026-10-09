import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {PickupRequestController} from '../controllers/pickup-request.controller';
import {PickupRequest} from '../models';

describe('pickup request detail', () => {
  it('returns display names, every bag number, and media URLs with rider notes', async () => {
    const pickup = {
      id: 'pickup-1',
      pincode: '400001',
      bagId: 'bag-1',
      mediaIds: ['media-1', 'missing-media'],
      reworkOfOrderId: 'order-1',
      convertedOrderId: 'order-2',
      itemCategoryEstimate: [{itemCategoryId: 'item-category-1', serviceId: 'service-1', quantity: 2}],
      actualItemsByService: [
        {serviceId: 'service-1', quantity: 2, bagId: 'bag-1', remarks: 'Small stain', mediaIds: ['media-2']},
        {serviceId: 'service-2', quantity: 1, bagId: 'bag-2', remarks: 'Handle with care'},
      ],
    } as PickupRequest;
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      pickupRequestRepository: {findOne: async () => pickup},
      storeScopeService: {resolve: async () => ({global: true})},
      riderPincodeMappingRepository: {find: async () => [{pincode: '400001', riderId: 'rider-1', rider: {firstName: 'A', lastName: 'B'}}]},
      orderRepository: {
        find: async () => [{id: 'order-1', orderNumber: 'ORD000001'}],
        findOne: async () => ({id: 'order-2', orderNumber: 'ORD000002'}),
      },
      bagRepository: {find: async () => [{id: 'bag-1', bagNumber: 101}, {id: 'bag-2', bagNumber: 102}]},
      mediaRepository: {find: async () => [{id: 'media-1', fileUrl: '/files/one.jpg'}, {id: 'media-2', fileUrl: '/files/two.jpg'}]},
      itemCategoryRepository: {find: async () => [{id: 'item-category-1', name: 'Clothes'}]},
      serviceRepository: {find: async () => [
        {id: 'service-1', name: 'Wash', serviceCategoryId: 'service-category-1'},
        {id: 'service-2', name: 'Dry clean', serviceCategoryId: 'service-category-1'},
      ]},
      serviceCategoryRepository: {find: async () => [{id: 'service-category-1', name: 'Laundry'}]},
    }) as PickupRequestController;

    const detail = await controller.findById({} as UserProfile, 'pickup-1') as {
      bagNumber: number;
      mediaIds: string[];
      mediaUrls: string[];
      suggestedRiderName: string;
      reworkOfOrderNumber: string;
      convertedOrderNumber: string;
      itemCategoryEstimate: Array<{itemCategoryName: string; serviceName: string}>;
      actualItemsByService: Array<{bagNumber: number; remarks: string; mediaUrls: string[]; serviceCategoryName: string}>;
    };

    expect(detail.bagNumber).to.equal(101);
    expect(detail.mediaIds).to.deepEqual(['media-1', 'missing-media']);
    expect(detail.mediaUrls).to.deepEqual(['/files/one.jpg']);
    expect(detail.suggestedRiderName).to.equal('A B');
    expect(detail.reworkOfOrderNumber).to.equal('ORD000001');
    expect(detail.convertedOrderNumber).to.equal('ORD000002');
    expect(detail.itemCategoryEstimate[0].itemCategoryName).to.equal('Clothes');
    expect(detail.itemCategoryEstimate[0].serviceName).to.equal('Wash');
    expect(detail.actualItemsByService.map(line => line.bagNumber)).to.deepEqual([101, 102]);
    expect(detail.actualItemsByService.map(line => line.remarks)).to.deepEqual(['Small stain', 'Handle with care']);
    expect(detail.actualItemsByService[0].mediaUrls).to.deepEqual(['/files/two.jpg']);
    expect(detail.actualItemsByService[1].mediaUrls).to.deepEqual([]);
    expect(detail.actualItemsByService[0].serviceCategoryName).to.equal('Laundry');
  });
});
