import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {PickupRequestController} from '../controllers/pickup-request.controller';
import {PickupRequest} from '../models';
import {DeliveryType} from '../models/delivery-type.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';

describe('pickup request detail', () => {
  it('allows a changed delivery plan until the first ticket exists', async () => {
    const pickup = {id: 'pickup-1', status: PickupRequestStatus.RECEIVED_AT_STORE} as PickupRequest;
    let linkedCount = 0;
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      pickupRequestRepository: {
        findOne: async () => pickup,
        updateById: async (_id: string, changes: Partial<PickupRequest>) => Object.assign(pickup, changes),
      },
      orderRepository: {count: async () => ({count: linkedCount})},
      storeScopeService: {resolve: async () => ({global: true})},
    }) as PickupRequestController;
    const first = [{deliveryType: DeliveryType.STANDARD, quantity: 1, itemSignature: '[{"quantity":1}]'}];
    const changed = [{deliveryType: DeliveryType.EXPRESS, quantity: 1, itemSignature: '[{"quantity":1}]'}];

    await controller.updateById({} as UserProfile, pickup.id, {conversionPlan: first});
    await controller.updateById({} as UserProfile, pickup.id, {conversionPlan: changed});
    expect(pickup.conversionPlan).to.deepEqual(changed);

    linkedCount = 1;
    let error: unknown;
    try {
      await controller.updateById({} as UserProfile, pickup.id, {conversionPlan: first});
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.match(/already been confirmed/);
  });

  it('shows every generated ticket while keeping legacy rework links', async () => {
    const pickups = [
      {id: 'pickup-1', conversionPlan: [
        {deliveryType: DeliveryType.EXPRESS, quantity: 2, itemSignature: '[private details]'},
        {deliveryType: DeliveryType.STANDARD, quantity: 1, itemSignature: '[private details]'},
      ]},
      {id: 'pickup-2', convertedOrderId: 'rework-order'},
    ] as PickupRequest[];
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      pickupRequestRepository: {find: async () => pickups},
      orderRepository: {find: async () => [
        {id: 'express-order', pickupRequestId: 'pickup-1', deliveryType: DeliveryType.EXPRESS},
        {id: 'standard-order', pickupRequestId: 'pickup-1', deliveryType: DeliveryType.STANDARD},
        {id: 'rework-order', deliveryType: DeliveryType.STANDARD},
      ]},
      storeScopeService: {resolve: async () => ({global: true}), narrowStoreIds: async () => undefined},
      enrichWithSuggestedRider: async (rows: PickupRequest[]) => rows,
      enrichWithReworkOrderNumber: async (rows: PickupRequest[]) => rows,
    }) as PickupRequestController;

    const result = await controller.find({} as UserProfile) as Array<{
      convertedOrders: Array<{orderId: string; deliveryType: DeliveryType}>;
      conversionPlan: Array<{deliveryType: DeliveryType; quantity: number; itemSignature?: string}>;
    }>;
    expect(result[0].convertedOrders.map(order => order.orderId)).to.deepEqual(['express-order', 'standard-order']);
    expect(result[1].convertedOrders.map(order => order.orderId)).to.deepEqual(['rework-order']);
    expect(result[0].conversionPlan).to.deepEqual([
      {deliveryType: DeliveryType.EXPRESS, quantity: 2},
      {deliveryType: DeliveryType.STANDARD, quantity: 1},
    ]);
  });

  it('keeps the legacy pickup link limited to one order', async () => {
    const pickup = {
      id: 'pickup-1',
      status: PickupRequestStatus.RECEIVED_AT_STORE,
      source: 'web',
      actualItemsByService: [
        {serviceId: 'a', quantity: 1, deliverySpeed: DeliveryType.LIGHTNING},
        {serviceId: 'b', quantity: 1, deliverySpeed: DeliveryType.EXPRESS},
        {serviceId: 'c', quantity: 1, deliverySpeed: DeliveryType.STANDARD},
      ],
    } as PickupRequest;
    const orders = [{id: 'order-0', deliveryType: DeliveryType.LIGHTNING}];
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      pickupRequestRepository: {
        findOne: async () => pickup,
        updateById: async (_id: string, changes: Partial<PickupRequest>) => Object.assign(pickup, changes),
      },
      storeScopeService: {resolve: async () => ({global: true})},
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
      orderRepository: {
        findOne: async ({where}: {where: {id: string}}) => orders.find(order => order.id === where.id),
        findById: async (id: string) => orders.find(order => order.id === id),
        updateById: async () => {},
      },
    }) as PickupRequestController;

    await controller.updateById({} as UserProfile, pickup.id, {convertedOrderId: orders[0].id});
    expect(pickup.convertedOrderId).to.equal('order-0');
    let duplicateError: unknown;
    try {
      await controller.updateById({} as UserProfile, pickup.id, {
        convertedOrderId: orders[0].id,
      });
    } catch (error) {
      duplicateError = error;
    }
    expect(String(duplicateError)).to.match(/already been converted/);
  });

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
        find: async ({where}: {where: {or?: Array<{pickupRequestId?: string}>}}) => where?.or
          ? [{id: 'order-2', orderNumber: 'ORD000002', deliveryType: DeliveryType.EXPRESS}]
          : [{id: 'order-1', orderNumber: 'ORD000001'}],
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
