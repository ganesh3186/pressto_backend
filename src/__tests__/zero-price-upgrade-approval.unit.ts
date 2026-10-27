import {expect} from '@loopback/testlab';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalService} from '../services/approval.service';

describe('zero-price upgrade approval', () => {
  it('leaves the request pending when an additional service is no longer priced', async () => {
    let wroteDecision = false;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {
        findById: async () => ({
          id: 'approval', status: ApprovalRequestStatus.PENDING,
          type: ApprovalRequestType.UPGRADE_SERVICE, entityId: 'garment',
          metadata: {additionalServiceIds: ['darning']},
        }),
        updateById: async () => {wroteDecision = true;},
      },
      approvalActionRepo: {create: async () => {wroteDecision = true;}},
      garmentRepo: {findOne: async () => ({id: 'garment', orderItemId: 'item'})},
      orderItemRepo: {findOne: async () => ({id: 'item', orderId: 'order', itemId: 'shirt'})},
      orderRepo: {findOne: async () => ({storeId: 'store', customerId: 'customer'})},
      garmentAdditionalServiceRepo: {find: async () => []},
      orderService: {resolvePricing: async () => {throw new Error('Additional service is unavailable at Rs.0');}},
    }) as ApprovalService;

    await expect(service.resolve({
      requestId: 'approval', action: ApprovalActionType.APPROVED, performedBy: 'staff',
    })).to.be.rejectedWith(/unavailable at Rs.0/);
    expect(wroteDecision).to.be.false();
  });
});
