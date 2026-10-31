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

  it('rejects a service category ID in place of the selected item category', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => []},
      serviceRepository: {find: async () => [{id: 'clean'}]},
    }) as PickupRequestController;

    await expect(controller.create({...selection,
      itemCategoryEstimate: [{itemCategoryId: 'pdc-service-category', serviceId: 'clean', quantity: 5}],
    })).to.be.rejectedWith(/valid item categories/);
  });

  it('stores only the service and item category selected for the pickup', async () => {
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      itemCategoryRepository: {find: async () => [{id: 'special-item-category'}]},
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
