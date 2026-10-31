/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial LoopBack records. */
import {expect} from '@loopback/testlab';
import {ApprovalService} from '../services/approval.service';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';

describe('return approval billing', () => {
  it('restores on rejection and reapplies the return on undo before payment', async () => {
    const order = {
      id: 'order-1', customerId: 'customer-1', status: 'received_at_store',
      subtotal: 200, discountAmount: 0, taxAmount: 36, totalAmount: 236,
    };
    const returningItem = {
      id: 'item-1', orderId: order.id, itemId: 'catalog-1',
      serviceId: 'service-1', quantity: 1, unitPrice: 100, totalPrice: 100,
    };
    const remainingItem = {
      id: 'item-2', orderId: order.id, itemId: 'catalog-1',
      serviceId: 'service-1', quantity: 1, unitPrice: 100, totalPrice: 100,
    };
    const garments = [
      {id: 'garment-1', orderItemId: returningItem.id, status: GarmentStatus.RECEIVED, isDeleted: false, garmentTagNumber: 'GT1'},
      {id: 'garment-2', orderItemId: remainingItem.id, status: GarmentStatus.READY, isDeleted: false, garmentTagNumber: 'GT2'},
    ];
    const documentItems = [
      {orderItemId: returningItem.id, quantity: 1, totalPrice: 100},
      {orderItemId: remainingItem.id, quantity: 1, totalPrice: 100},
    ];
    const invoice = {id: 'invoice-1', orderId: order.id, subtotal: 200, totalAmount: 236,
      balanceDue: 0, items: [...documentItems]};
    const challan = {id: 'challan-1', orderId: order.id, subtotal: 200, totalAmount: 236,
      items: [...documentItems]};
    const requests = new Map<string, any>();
    const refundDues: any[] = [];
    let paidAmount = 100;
    const items = [returningItem, remainingItem];
    const emptyFind = {find: async () => []};
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {
        create: async (value: any) => { value.createdAt = new Date(); requests.set(value.id, value); return value; },
        findById: async (id: string) => requests.get(id),
        findOne: async ({where}: any) => [...requests.values()]
          .filter(value => value.type === where.type && value.entityId === where.entityId)
          .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0],
        updateById: async (id: string, patch: any) => Object.assign(requests.get(id), patch),
      },
      approvalActionRepo: {create: async () => {}},
      approvalAuditLogRepo: {create: async () => {}},
      garmentRepo: {
        findById: async (id: string) => garments.find(g => g.id === id),
        findOne: async ({where}: any) => garments.find(g => g.id === where.id),
        find: async ({where}: any) => garments.filter(g =>
          (!where.orderItemId || (typeof where.orderItemId === 'string'
            ? g.orderItemId === where.orderItemId
            : where.orderItemId.inq.includes(g.orderItemId))) &&
          (!where.status || (where.status.nin
            ? !where.status.nin.includes(g.status)
            : g.status !== where.status.neq))),
        count: async ({orderItemId, status}: any) => ({
          count: garments.filter(g => g.orderItemId === orderItemId && g.status !== status.neq).length,
        }),
      },
      garmentStatusHistoryRepo: {find: async () => [{status: GarmentStatus.RECEIVED}]},
      orderItemRepo: {
        findById: async (id: string) => items.find(item => item.id === id),
        findOne: async ({where}: any) => items.find(item => item.id === where.id),
        find: async () => items,
        updateById: async (id: string, patch: any) => Object.assign(items.find(item => item.id === id)!, patch),
      },
      orderRepo: {
        findById: async () => order,
        findOne: async () => order,
        updateById: async (_id: string, patch: any) => Object.assign(order, patch),
      },
      itemRepo: {findById: async () => ({isMeasurement: false}), findOne: async () => ({isMeasurement: false})},
      garmentAdditionalServiceRepo: emptyFind,
      garmentAdditionalChargeRepo: emptyFind,
      orderItemAdditionalChargeRepo: emptyFind,
      paymentRepo: {find: async () => [{amount: paidAmount, transactionType: 'payment'}]},
      orderService: {computeBalanceDue: async () => ({alreadyPaid: paidAmount,
        due: Math.max(0, order.totalAmount - paidAmount)})},
      refundDueRepo: {
        find: async ({where}: any) => refundDues.filter(due =>
          !where?.status?.inq || where.status.inq.includes(due.status)),
        findOne: async ({where}: any) => refundDues.find(due =>
          where.id ? due.id === where.id : due.sourceId === where.sourceId),
        create: async (value: any) => { refundDues.push(value); return value; },
        updateById: async (id: string, patch: any) => Object.assign(refundDues.find(due => due.id === id)!, patch),
      },
      invoiceRepo: {
        findOne: async () => invoice,
        updateById: async (_id: string, patch: any) => Object.assign(invoice, patch),
      },
      challanRepo: {
        findOne: async () => challan,
        updateById: async (_id: string, patch: any) => Object.assign(challan, patch),
      },
      auditService: {log: async () => {}},
      _maybeMarkOrderReturned: async () => {},
      _updateGarmentStatus: async (id: string, status: GarmentStatus) => {
        Object.assign(garments.find(g => g.id === id)!, {status});
      },
    }) as ApprovalService;

    const request = await service.createRequest({
      type: ApprovalRequestType.RETURN_ITEM,
      entityType: 'garment', entityId: 'garment-1', requestedBy: 'user-1',
    });
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(challan.totalAmount).to.equal(118);
    expect(returningItem.quantity).to.equal(0);
    expect(refundDues).to.have.length(0);
    order.status = 'ready';
    invoice.items = invoice.items.filter(item => item.orderItemId !== returningItem.id);
    challan.items = challan.items.filter(item => item.orderItemId !== returningItem.id);
    invoice.balanceDue = 12;

    await service.resolve({
      requestId: request.id, action: ApprovalActionType.REJECTED,
      performedBy: 'user-2',
    });
    expect(order.totalAmount).to.equal(236);
    expect(order.status).to.equal('ready');
    expect(requests.get(request.id).metadata._returnOriginalSnapshot.order.status)
      .to.equal('received_at_store');
    expect(invoice.totalAmount).to.equal(236);
    expect(invoice.balanceDue).to.equal(136);
    expect(invoice.items.map(item => item.orderItemId)).to.deepEqual(documentItems.map(item => item.orderItemId));
    expect(challan.totalAmount).to.equal(236);
    expect(challan.items.map(item => item.orderItemId)).to.deepEqual(documentItems.map(item => item.orderItemId));
    expect(returningItem.quantity).to.equal(1);
    expect(garments[0].status).to.equal(GarmentStatus.RECEIVED);
    expect(refundDues).to.have.length(0);

    await service.revert({requestId: request.id, performedBy: 'user-2'});
    expect(requests.get(request.id).status).to.equal(ApprovalRequestStatus.PENDING);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(returningItem.quantity).to.equal(0);
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(refundDues).to.have.length(0);

    await service.resolve({
      requestId: request.id, action: ApprovalActionType.APPROVED,
      performedBy: 'user-2',
    });
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(returningItem.quantity).to.equal(0);
    expect(refundDues).to.have.length(0);

    await service.revert({requestId: request.id, performedBy: 'user-2'});
    expect(requests.get(request.id).status).to.equal(ApprovalRequestStatus.PENDING);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(returningItem.quantity).to.equal(0);
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(refundDues).to.have.length(0);

    await service.resolve({
      requestId: request.id, action: ApprovalActionType.APPROVED,
      performedBy: 'user-2',
    });
    paidAmount = 118;
    await expect(service.revert({requestId: request.id, performedBy: 'user-2'}))
      .to.be.rejectedWith(/payment succeeded/);
    expect(requests.get(request.id).status).to.equal(ApprovalRequestStatus.APPROVED);
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);

    requests.set('older-return', {
      id: 'older-return', type: ApprovalRequestType.RETURN_ITEM,
      entityType: 'garment', entityId: 'garment-1',
      status: ApprovalRequestStatus.REJECTED,
      createdAt: new Date(request.createdAt!.getTime() - 1000),
    });
    await expect(service.revert({requestId: 'older-return', performedBy: 'user-2'}))
      .to.be.rejectedWith(/Only the latest request of this type/);
  });

  it('keeps the returned item and its charge removed after ticket payment succeeds', async () => {
    const request: any = {
      id: 'return-1', type: ApprovalRequestType.RETURN_ITEM,
      entityType: 'garment', entityId: 'garment-1',
      status: ApprovalRequestStatus.PENDING,
      metadata: {_returnBillingApplied: true},
    };
    const garment = {id: 'garment-1', orderItemId: 'item-1',
      status: GarmentStatus.RETURNED_TO_CUSTOMER};
    const orderItem = {id: 'item-1', orderId: 'order-1', quantity: 0};
    const order = {id: 'order-1', totalAmount: 118};
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {
        findById: async () => request,
        findOne: async () => request,
        updateById: async (_id: string, patch: any) => Object.assign(request, patch),
      },
      approvalActionRepo: {create: async () => {}},
      approvalAuditLogRepo: {create: async () => {}},
      garmentRepo: {findById: async () => garment, findOne: async () => garment},
      orderItemRepo: {findById: async () => orderItem},
      orderRepo: {findById: async () => order},
      orderService: {computeBalanceDue: async () => ({alreadyPaid: 118, due: 0})},
      auditService: {log: async () => {}},
      _captureSnapshot: async () => ({}),
    }) as ApprovalService;

    await service.resolve({requestId: request.id, action: ApprovalActionType.REJECTED,
      performedBy: 'user-2'});
    expect(request.status).to.equal(ApprovalRequestStatus.REJECTED);
    expect(request.metadata._returnBillingApplied).to.equal(true);
    expect(garment.status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(orderItem.quantity).to.equal(0);
    expect(order.totalAmount).to.equal(118);
    await expect(service.revert({requestId: request.id, performedBy: 'user-2'}))
      .to.be.rejectedWith(/payment succeeded/);
    expect(request.status).to.equal(ApprovalRequestStatus.REJECTED);

    // A pending request from before immediate return billing has no marker.
    request.status = ApprovalRequestStatus.PENDING;
    request.metadata = {};
    let appliedReturnBilling = false;
    (service as any)._ensureReturnBillingApplied = async () => { appliedReturnBilling = true; };
    await service.resolve({requestId: request.id, action: ApprovalActionType.APPROVED,
      performedBy: 'user-2'});
    expect(appliedReturnBilling).to.equal(false);
    expect(garment.status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(order.totalAmount).to.equal(118);
  });
});
