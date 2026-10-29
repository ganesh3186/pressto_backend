import {expect} from '@loopback/testlab';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {
  GARMENT_STATUS_TRANSITIONS,
  GarmentStatus,
  isActiveGarmentStatus,
} from '../models/garment-status.enum';
import {ApprovalService} from '../services/approval.service';

describe('damage approval status', () => {
  it('resumes the stage before damage when an approval was reverted and rejected', async () => {
    let restored: GarmentStatus | undefined;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {findOne: async () => ({status: GarmentStatus.ON_HOLD})},
      garmentStatusHistoryRepo: {find: async () => [
        {status: GarmentStatus.ON_HOLD},
        {status: GarmentStatus.DAMAGED},
        {status: GarmentStatus.ON_HOLD},
        {status: GarmentStatus.RECEIVED},
      ]},
      _updateGarmentStatus: async (_id: string, status: GarmentStatus) => {restored = status;},
    }) as ApprovalService;

    const resume = Reflect.get(service, '_resumeGarmentFromHold') as (
      garmentId: string, performedBy: string, reason: string,
    ) => Promise<void>;
    await resume.call(service, 'garment-1', 'approver-1', 'Damage rejected');

    expect(restored).to.equal(GarmentStatus.RECEIVED);
  });

  it('moves an approved damage report from on hold to damaged', async () => {
    const updates: GarmentStatus[] = [];
    const history: GarmentStatus[] = [];
    const billing: string[] = [];
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {
        findOne: async () => ({id: 'garment-1', status: GarmentStatus.ON_HOLD}),
        updateById: async (_id: string, update: {status: GarmentStatus}) => {
          updates.push(update.status);
        },
      },
      garmentStatusHistoryRepo: {
        create: async (entry: {status: GarmentStatus}) => {
          history.push(entry.status);
        },
      },
      _applyReturnEffect: async () => { billing.push('credited'); },
    }) as ApprovalService;

    const applyApproveEffect = Reflect.get(service, '_applyApproveEffect') as (
      request: ApprovalRequest,
      performedBy: string,
    ) => Promise<void>;
    await applyApproveEffect.call(service,
      {
        type: ApprovalRequestType.ITEM_DAMAGED,
        entityType: 'garment',
        entityId: 'garment-1',
      } as ApprovalRequest,
      'approver-1',
    );

    expect(updates).to.eql([GarmentStatus.DAMAGED]);
    expect(history).to.eql([GarmentStatus.DAMAGED]);
    expect(billing).to.eql(['credited']);
    expect(GARMENT_STATUS_TRANSITIONS[GarmentStatus.ON_HOLD]).to.containEql(GarmentStatus.DAMAGED);
    expect(isActiveGarmentStatus(GarmentStatus.DAMAGED)).to.be.false();
  });

  it('removes an approved damaged piece from a paid order and records the amount owed', async () => {
    const order = {id: 'order-1', customerId: 'customer-1', subtotal: 200,
      discountAmount: 0, taxAmount: 36, totalAmount: 236};
    const items = [
      {id: 'item-1', orderId: order.id, itemId: 'catalog-1', quantity: 1, unitPrice: 100, totalPrice: 100},
      {id: 'item-2', orderId: order.id, itemId: 'catalog-1', quantity: 1, unitPrice: 100, totalPrice: 100},
    ];
    const garments = [
      {id: 'garment-1', orderItemId: 'item-1', status: GarmentStatus.ON_HOLD, garmentTagNumber: 'GT1'},
      {id: 'garment-2', orderItemId: 'item-2', status: GarmentStatus.READY, garmentTagNumber: 'GT2'},
    ];
    const invoice = {id: 'invoice-1', subtotal: 200, totalAmount: 236, balanceDue: 0};
    const challan = {id: 'challan-1', subtotal: 200, totalAmount: 236};
    let refundAmount = 0;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {
        findOne: async ({where}: {where: {id: string}}) => garments.find(g => g.id === where.id),
        find: async ({where}: {where: {status: {nin: GarmentStatus[]}}}) =>
          garments.filter(g => !where.status.nin.includes(g.status)),
      },
      orderItemRepo: {
        findOne: async ({where}: {where: {id: string}}) => items.find(i => i.id === where.id),
        find: async () => items,
        updateById: async (_id: string, patch: object) => Object.assign(items[0], patch),
      },
      orderRepo: {
        findOne: async () => order,
        updateById: async (_id: string, patch: object) => Object.assign(order, patch),
      },
      itemRepo: {findOne: async () => ({isMeasurement: false})},
      garmentAdditionalServiceRepo: {find: async () => []},
      garmentAdditionalChargeRepo: {find: async () => []},
      orderItemAdditionalChargeRepo: {find: async () => []},
      invoiceRepo: {findOne: async () => invoice,
        updateById: async (_id: string, patch: object) => Object.assign(invoice, patch)},
      challanRepo: {findOne: async () => challan,
        updateById: async (_id: string, patch: object) => Object.assign(challan, patch)},
      calculateGarmentReturnAmount: async () => ({itemPrice: 100, additionalServiceCharge: 0,
        addOnCharge: 0, returnAmount: 118}),
      _computeOverpaymentRefund: async () => ({refundAmount: 118, newBalanceDue: 0}),
      _maybeMarkOrderReturned: async () => {},
      _mergeIntoSnapshot: async () => {},
      createRefundDue: async ({amount}: {amount: number}) => {refundAmount = amount; return {id: 'refund-1'};},
      _updateGarmentStatus: async (_id: string, status: GarmentStatus) => {garments[0].status = status;},
      auditService: {log: async () => {}},
    }) as ApprovalService;

    const applyApproveEffect = Reflect.get(service, '_applyApproveEffect') as (
      request: ApprovalRequest, performedBy: string,
    ) => Promise<void>;
    await applyApproveEffect.call(service, {id: 'approval-1', type: ApprovalRequestType.ITEM_DAMAGED,
      entityType: 'garment', entityId: 'garment-1'} as ApprovalRequest, 'approver-1');

    expect(garments[0].status).to.equal(GarmentStatus.DAMAGED);
    expect(items[0].quantity).to.equal(0);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(challan.totalAmount).to.equal(118);
    expect(refundAmount).to.equal(118);
  });

  it('prepares an older approved damage refund only once', async () => {
    const orderItem = {id: 'item-1', orderId: 'order-1', quantity: 1};
    const garment = {id: 'garment-1', orderItemId: orderItem.id, status: GarmentStatus.DAMAGED,
      garmentTagNumber: 'GT1'};
    const approval = {id: 'approval-1', type: ApprovalRequestType.ITEM_DAMAGED};
    const refunds: Array<{id: string; sourceId: string; status: string; amount: number}> = [];
    let applications = 0;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      garmentRepo: {findOne: async () => garment, count: async () => ({count: 0})},
      orderItemRepo: {findById: async () => orderItem},
      approvalRequestRepo: {findOne: async () => approval},
      refundDueRepo: {findOne: async () => refunds[0] || null},
      _applyReturnEffect: async () => {
        applications += 1;
        orderItem.quantity = 0;
        refunds.push({id: 'refund-1', sourceId: garment.id, status: 'pending', amount: 118});
      },
    }) as ApprovalService;

    const first = await service.prepareDamagedRefund('order-1', garment.id, 'staff-1');
    const second = await service.prepareDamagedRefund('order-1', garment.id, 'staff-1');
    expect(first?.id).to.equal('refund-1');
    expect(second?.id).to.equal('refund-1');
    expect(applications).to.equal(1);
  });
});
