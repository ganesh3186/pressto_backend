import {expect} from '@loopback/testlab';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderService} from '../services/order.service';

describe('delivery garment readiness guard', () => {
  it('blocks pending damage and unfinished garments', async () => {
    let pending = true;
    let garmentStatus = GarmentStatus.ON_HOLD;
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [{id: 'item-1', orderId: 'order-1'}]},
      garmentRepo: {find: async () => [
        {id: 'garment-1', orderItemId: 'item-1', status: garmentStatus},
        {id: 'garment-2', orderItemId: 'item-1', status: GarmentStatus.READY},
      ]},
      approvalRequestRepo: {findOne: async ({where}: {where: {
        type: ApprovalRequestType; status: ApprovalRequestStatus;
        entityId: {inq: string[]};
      }}) => {
        expect(where.type).to.equal(ApprovalRequestType.ITEM_DAMAGED);
        expect(where.status).to.equal(ApprovalRequestStatus.PENDING);
        expect(where.entityId.inq).to.eql(['garment-1', 'garment-2']);
        return pending ? {id: 'approval-1'} : null;
      }},
    }) as OrderService;

    await expect(service.assertGarmentsReadyForDelivery(['order-1']))
      .to.be.rejectedWith(/Resolve the pending damage approval/);
    pending = false;
    garmentStatus = GarmentStatus.IN_INSPECTION;
    await expect(service.assertGarmentsReadyForDelivery(['order-1']))
      .to.be.rejectedWith(/All non-returned items must be ready/);
    garmentStatus = GarmentStatus.READY;
    await service.assertGarmentsReadyForDelivery(['order-1']);
  });
});
