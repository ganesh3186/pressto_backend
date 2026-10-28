import {expect} from '@loopback/testlab';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalService} from '../services/approval.service';

describe('approved upgrade view', () => {
  it('keeps the original service and price after the order item changes', async () => {
    let addonAttached = false;
    let deliveryPercent = 0;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {
        findOne: async () => ({id: 'garment-1', orderItemId: 'item-1'}),
      },
      orderItemRepo: {
        findOne: async () => ({
          id: 'item-1',
          orderId: 'order-1',
          serviceId: 'press',
          itemId: 'shirt',
          resolvedPrice: 204,
          unitPrice: 204,
        }),
      },
      orderRepo: {
        findOne: async () => ({
          id: 'order-1',
          storeId: 'store-1',
          customerId: 'customer-1',
          deliveryTypePercentage: deliveryPercent,
        }),
      },
      serviceRepo: {
        findOne: async ({where}: {where: {id: string}}) => ({
          id: where.id,
          name: where.id === 'clean' ? 'Clean' : 'Press',
        }),
        find: async () => [{id: 'addon', name: 'Stain Treatment'}],
      },
      itemRepo: {findOne: async () => ({name: 'Shirt', isMeasurement: false})},
      garmentAdditionalServiceRepo: {
        find: async () => addonAttached ? [{serviceId: 'addon', amount: 25}] : [],
      },
      approvalActionRepo: {findOne: async () => null},
      orderService: {
        resolvePricing: async (_storeId: string, serviceId: string) => ({
          resolvedPrice: serviceId === 'addon' ? 25 : 204,
        }),
      },
      resolveMedia: async () => [],
    }) as ApprovalService;

    const request = {
      id: 'approval-1',
      entityId: 'garment-1',
      status: ApprovalRequestStatus.APPROVED,
      metadata: {
        toServiceId: 'press',
        _revertSnapshot: {
          orderItem: {serviceId: 'clean', resolvedPrice: 100, unitPrice: 100},
        },
      },
    } as unknown as ApprovalRequest;

    const view = await service.getUpgradeView(request);
    expect(view.currentService).to.containEql({name: 'Clean', unitPrice: 100});
    expect(view.requestedService).to.containEql({
      name: 'Press',
      unitPrice: 204,
    });
    expect(view.pricing).to.containEql({currentTotal: 100, newTotal: 204});

    deliveryPercent = 20;
    request.status = ApprovalRequestStatus.PENDING;
    request.metadata = {
      toServiceId: 'press',
      fromServiceId: 'clean',
      fromResolvedPrice: 100,
      fromUnitPrice: 100,
      additionalServiceIds: ['addon'],
    };
    const pendingView = await service.getUpgradeView(request);
    expect(pendingView.currentService).to.containEql({name: 'Clean', unitPrice: 100});
    expect(pendingView.requestedAdditionalServices).to.deepEqual([
      {id: 'addon', name: 'Stain Treatment', amount: 25, unitPrice: 30},
    ]);

    addonAttached = true;
    request.status = ApprovalRequestStatus.APPROVED;
    const approvedView = await service.getUpgradeView(request);
    expect(approvedView.requestedAdditionalServices).to.deepEqual([
      {id: 'addon', name: 'Stain Treatment', amount: 25, unitPrice: 30},
    ]);
  });
});
