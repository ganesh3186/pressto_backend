/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial LoopBack records. */
import {expect} from '@loopback/testlab';
import {ApprovalService} from '../services/approval.service';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';

describe('return approval billing', () => {
  it('removes a paid garment at request time and keeps it off the invoice after rejection and revert', async () => {
    const order = {
      id: 'order-1', customerId: 'customer-1', status: 'ready',
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
      {id: 'garment-1', orderItemId: returningItem.id, status: GarmentStatus.READY, isDeleted: false, garmentTagNumber: 'GT1'},
      {id: 'garment-2', orderItemId: remainingItem.id, status: GarmentStatus.READY, isDeleted: false, garmentTagNumber: 'GT2'},
    ];
    const invoice = {id: 'invoice-1', orderId: order.id, subtotal: 200, totalAmount: 236, balanceDue: 0};
    const challan = {id: 'challan-1', orderId: order.id, subtotal: 200, totalAmount: 236};
    const requests = new Map<string, any>();
    const refundDues: any[] = [];
    const items = [returningItem, remainingItem];
    const emptyFind = {find: async () => []};
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {
        create: async (value: any) => { requests.set(value.id, value); return value; },
        findById: async (id: string) => requests.get(id),
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
          (!where.status || g.status !== where.status.neq)),
        count: async ({orderItemId, status}: any) => ({
          count: garments.filter(g => g.orderItemId === orderItemId && g.status !== status.neq).length,
        }),
      },
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
      paymentRepo: {find: async () => [{amount: 236, transactionType: 'payment'}]},
      refundDueRepo: {
        find: async () => refundDues,
        create: async (value: any) => { refundDues.push(value); return value; },
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
    expect(refundDues).to.have.length(1);
    expect(refundDues[0].amount).to.equal(118);

    await service.resolve({
      requestId: request.id, action: ApprovalActionType.REJECTED,
      performedBy: 'user-2',
    });
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(refundDues).to.have.length(1);

    await service.revert({requestId: request.id, performedBy: 'user-2'});
    expect(requests.get(request.id).status).to.equal(ApprovalRequestStatus.PENDING);
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(garments[0].status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(refundDues).to.have.length(1);

    await service.resolve({
      requestId: request.id, action: ApprovalActionType.APPROVED,
      performedBy: 'user-2',
    });
    expect(order.totalAmount).to.equal(118);
    expect(invoice.totalAmount).to.equal(118);
    expect(returningItem.quantity).to.equal(0);
    expect(refundDues).to.have.length(1);
  });
});
