import {expect} from '@loopback/testlab';
import {GarmentActionsController} from '../controllers/garment-actions.controller';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalService} from '../services/approval.service';

describe('upgrade service pricing', () => {
  it('does not hold a garment or request approval for an unpriced service', async () => {
    let requested = false;
    const controller = Object.assign(Object.create(GarmentActionsController.prototype), {
      storeScopeService: {assertGarmentEditable: async () => {}},
      garmentRepo: {findOne: async () => ({id: 'garment-1', orderItemId: 'item-1'})},
      orderItemRepo: {findOne: async () => ({
        id: 'item-1', orderId: 'order-1', itemId: 'shirt', serviceId: 'clean',
      })},
      serviceRepo: {findOne: async () => ({id: 'new-service', name: 'Premium'})},
      orderRepo: {findOne: async () => ({id: 'order-1', storeId: 'store-1', customerId: 'customer-1'})},
      orderService: {resolvePricing: async () => { throw new Error('No base price configured'); }},
      approvalService: {createRequest: async () => { requested = true; }},
    }) as GarmentActionsController;

    await expect(controller.requestUpgrade({} as never, 'garment-1', {
      toServiceId: 'new-service',
    })).to.be.rejectedWith(/No base price configured/);
    expect(requested).to.equal(false);
  });

  it('does not swap service or price if pricing disappears before approval', async () => {
    let updated = false;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      orderItemRepo: {
        findOne: async () => ({id: 'item-1', orderId: 'order-1', basePrice: 100, resolvedPrice: 110}),
        updateById: async () => { updated = true; },
      },
      orderRepo: {findOne: async () => ({id: 'order-1', storeId: 'store-1', customerId: 'customer-1'})},
      orderService: {resolvePricing: async () => { throw new Error('No base price configured'); }},
    }) as ApprovalService;
    const apply = service as unknown as {
      _applyUpgradeOnOrderItem: (
        orderItemId: string, request: ApprovalRequest, performedBy: string,
        garmentId: string, prices: Map<string, number>,
      ) => Promise<void>;
    };

    await expect(apply._applyUpgradeOnOrderItem(
      'item-1', {metadata: {toServiceId: 'new-service'}} as unknown as ApprovalRequest,
      'staff-1', 'garment-1', new Map(),
    )).to.be.rejectedWith(/No base price configured/);
    expect(updated).to.equal(false);
  });

  it('does not record customer approval when the target service lost its price', async () => {
    let decisionWritten = false;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {findById: async () => ({
        id: 'request-1', type: ApprovalRequestType.UPGRADE_SERVICE,
        entityId: 'garment-1', status: ApprovalRequestStatus.PENDING,
        metadata: {toServiceId: 'new-service'},
      })},
      garmentRepo: {findOne: async () => ({id: 'garment-1', orderItemId: 'item-1'})},
      orderItemRepo: {findOne: async () => ({id: 'item-1', orderId: 'order-1', itemId: 'shirt'})},
      orderRepo: {findOne: async () => ({id: 'order-1', storeId: 'store-1', customerId: 'customer-1'})},
      orderService: {resolvePricing: async () => { throw new Error('No base price configured'); }},
      approvalActionRepo: {create: async () => { decisionWritten = true; }},
    }) as ApprovalService;

    await expect(service.resolve({
      requestId: 'request-1', action: ApprovalActionType.APPROVED, performedBy: 'customer-1',
    })).to.be.rejectedWith(/No base price configured/);
    expect(decisionWritten).to.equal(false);
  });
});
