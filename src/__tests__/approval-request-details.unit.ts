import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ApprovalController} from '../controllers/approval.controller';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';

describe('approval request details', () => {
  it('shows customer contact and the requested service for customer and internal approvals', async () => {
    const requests = [
      {
        id: 'upgrade',
        type: ApprovalRequestType.UPGRADE_SERVICE,
        status: ApprovalRequestStatus.REJECTED,
        entityType: 'garment',
        entityId: 'garment-1',
        metadata: {
          toServiceId: 'service-1',
          additionalServiceIds: ['service-2'],
        },
      },
      {
        id: 'downgrade',
        type: ApprovalRequestType.ORDER_ITEMS_DOWNGRADE,
        entityType: 'order',
        entityId: 'order-1',
      },
    ];
    const controller = Object.assign(
      Object.create(ApprovalController.prototype),
      {
        storeScopeService: {resolve: async () => ({global: true})},
        approvalRequestRepo: {
          count: async () => ({count: 2}),
          find: async () => requests,
        },
        approvalService: {resolveMedia: async () => []},
        approvalActionRepo: {findOne: async () => ({comments: 'Customer declined the extra cost'})},
        garmentRepo: {
          findOne: async () => ({
            orderItemId: 'item-1',
            garmentTagNumber: 'TAG-1',
          }),
        },
        orderItemRepo: {
          findOne: async () => ({orderId: 'order-1', itemName: 'Shirt'}),
        },
        orderRepo: {
          findOne: async () => ({
            id: 'order-1',
            customerId: 'customer-1',
            orderNumber: 'TICKET-1',
          }),
        },
        itemRepo: {findOne: async () => null},
        customerRepo: {
          findOne: async () => ({
            firstName: 'Asha',
            lastName: 'Patel',
            user: {countryCode: '+91', phone: '9876543210'},
          }),
        },
        serviceRepo: {
          findOne: async ({where}: {where: {id: string}}) => ({
            name: where.id === 'service-1' ? 'Dry Clean' : 'Stain Removal',
          }),
        },
      },
    ) as ApprovalController;

    const result = (await controller.list({} as UserProfile)) as {
      requests: Array<{
        customerName: string;
        customerPhone: string;
        requestedService?: string;
        displayReason?: string;
      }>;
    };

    expect(result.requests[0]).to.containEql({
      customerName: 'Asha Patel',
      customerPhone: '+91 9876543210',
      requestedService: 'Dry Clean, Stain Removal',
      displayReason: 'Decision: Customer declined the extra cost',
    });
    expect(result.requests[1]).to.containEql({
      customerName: 'Asha Patel',
      customerPhone: '+91 9876543210',
    });
  });
});
