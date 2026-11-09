import {expect} from '@loopback/testlab';
import {PickupRequestController} from '../controllers/pickup-request.controller';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';

describe('pickup request category selection', () => {
  const selection = {
    customerName: 'Customer',
    customerMobile: '9999999999',
    address: 'Address',
    requestedDate: '2026-10-31',
    slot: 'Morning',
    source: PickupRequestSource.CALL,
    itemCategoryEstimate: [{itemCategoryId: 'special-item-category', serviceId: 'clean', quantity: 5}],
  };

  it('rejects an ID that is neither an item category nor a service category', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => []},
      serviceCategoryRepository: {find: async () => []},
      serviceRepository: {find: async () => [{id: 'clean'}]},
    }) as PickupRequestController;

    await expect(controller.create({...selection,
      itemCategoryEstimate: [{itemCategoryId: 'unknown-category', serviceId: 'clean', quantity: 5}],
    })).to.be.rejectedWith(/valid categories/);
  });

  it('accepts a service category ID on an estimate line', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => []},
      serviceCategoryRepository: {find: async () => [{id: 'pdc-service-category'}]},
      serviceRepository: {find: async () => [{id: 'clean'}]},
      pickupRequestRepository: {count: async () => ({count: 0})},
      pickupRequestService: {createRequest: async (body: object) => body},
    }) as PickupRequestController;
    const lines = [{itemCategoryId: 'pdc-service-category', serviceId: 'clean', quantity: 5}];

    const result = await controller.create({...selection, itemCategoryEstimate: lines}) as {
      pickupRequest: {itemCategoryEstimate: unknown[]};
    };
    expect(result.pickupRequest.itemCategoryEstimate).to.deepEqual(lines);
  });

  it('accepts an estimate line with no item category', async () => {
    const line = {serviceId: 'clean', quantity: 5};
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      serviceRepository: {find: async () => [{id: 'clean'}]},
      pickupRequestRepository: {count: async () => ({count: 0})},
      pickupRequestService: {createRequest: async (body: object) => body},
    }) as PickupRequestController;

    const result = await controller.create({...selection, itemCategoryEstimate: [line]}) as {
      pickupRequest: {itemCategoryEstimate: unknown[]};
    };
    expect(result.pickupRequest.itemCategoryEstimate).to.deepEqual([line]);
  });

  it('stores only the service and item category selected for the pickup', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => [{id: 'special-item-category'}]},
      serviceCategoryRepository: {find: async () => []},
      serviceRepository: {find: async () => [{id: 'clean'}]},
      pickupRequestRepository: {count: async () => ({count: 0})},
      pickupRequestService: {createRequest: async (body: object) => body},
    }) as PickupRequestController;

    const result = await controller.create(selection) as {pickupRequest: {itemCategoryEstimate: unknown[]}};
    expect(result.pickupRequest.itemCategoryEstimate).to.deepEqual(selection.itemCategoryEstimate);
  });

  it('accepts the original service of an approved rework even when no longer active', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => []},
      approvalRequestRepository: {findOne: async () => ({id: 'approval-1', status: ApprovalRequestStatus.APPROVED})},
      orderItemRepository: {find: async () => [{serviceId: 'clean', itemId: 'item-1'}]},
      itemRepository: {find: async () => [{id: 'item-1', itemCategoryId: 'special-item-category'}]},
      pickupRequestRepository: {findOne: async () => null, count: async () => ({count: 0})},
      pickupRequestService: {createRequest: async (body: object) => body},
    }) as PickupRequestController;

    const result = await controller.create({...selection, isReworkPickup: true,
      reworkOfOrderId: 'order-1', reworkApprovalRequestId: 'approval-1',
    }) as {pickupRequest: {itemCategoryEstimate: unknown[]}};
    expect(result.pickupRequest.itemCategoryEstimate).to.deepEqual(selection.itemCategoryEstimate);
  });

  describe('rework line with no item category', () => {
    const reworkController = () => Object.assign(Object.create(PickupRequestController.prototype), {
      approvalRequestRepository: {findOne: async () => ({id: 'approval-1', status: ApprovalRequestStatus.APPROVED})},
      orderItemRepository: {find: async () => [{serviceId: 'clean', itemId: 'item-1'}]},
      itemRepository: {find: async () => [{id: 'item-1', itemCategoryId: 'special-item-category'}]},
      pickupRequestRepository: {findOne: async () => null, count: async () => ({count: 0})},
      pickupRequestService: {createRequest: async (body: object) => body},
    }) as PickupRequestController;
    const rework = {...selection, isReworkPickup: true, reworkOfOrderId: 'order-1', reworkApprovalRequestId: 'approval-1'};

    it('is accepted when its service was on the original order', async () => {
      const line = {serviceId: 'clean', quantity: 1};
      const result = await reworkController().create({...rework, itemCategoryEstimate: [line]}) as {
        pickupRequest: {itemCategoryEstimate: unknown[]};
      };
      expect(result.pickupRequest.itemCategoryEstimate).to.deepEqual([line]);
    });

    it('is rejected when its service was not on the original order', async () => {
      await expect(reworkController().create({...rework, itemCategoryEstimate: [{serviceId: 'other', quantity: 1}]}))
        .to.be.rejectedWith(/belong to the original order/);
    });
  });

  it('rejects a rework service that was not on the original order', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => [{id: 'special-item-category'}]},
      approvalRequestRepository: {findOne: async () => ({id: 'approval-1', status: ApprovalRequestStatus.APPROVED})},
      orderItemRepository: {find: async () => []},
    }) as PickupRequestController;

    await expect(controller.create({...selection, isReworkPickup: true,
      reworkOfOrderId: 'order-1', reworkApprovalRequestId: 'approval-1',
    })).to.be.rejectedWith(/belong to the original order/);
  });
});
