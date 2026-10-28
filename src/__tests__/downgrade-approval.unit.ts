import {expect} from '@loopback/testlab';
import {securityId} from '@loopback/security';
import {OrderController} from '../controllers/order.controller';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalService} from '../services/approval.service';
import {OrderService} from '../services/order.service';

describe('order downgrade approval', () => {
  it('records the later decision without applying the edit again', async () => {
    let applied = false;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      _applyOrderItemsDowngrade: async () => {applied = true;},
    }) as ApprovalService;
    const approve = service as unknown as {_applyApproveEffect: (
      request: object, user: string, prices: Map<string, number>,
    ) => Promise<void>};
    await approve._applyApproveEffect({
      entityType: 'order', type: ApprovalRequestType.ORDER_ITEMS_DOWNGRADE,
      metadata: {_appliedAtRequest: true},
    }, 'manager-1', new Map());
    expect(applied).to.equal(false);
  });

  it('saves another downgrade while a previous approval is pending', async () => {
    const steps: string[] = [];
    const transaction = {};
    const request = {id: 'approval-2', requestReason: 'removed add-on'};
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      approvalRequestRepo: {find: async () => [{id: 'approval-1', metadata: {_appliedAtRequest: true}}],
        updateById: async () => {throw new Error('Existing applied request must stay pending');}},
      approvalService: {
        createRequest: async (data: {type: string; metadata: {_appliedAtRequest: boolean}}, tx: object) => {
          expect(tx).to.equal(transaction);
          expect(data.type).to.equal(ApprovalRequestType.ORDER_ITEMS_DOWNGRADE);
          expect(data.metadata._appliedAtRequest).to.equal(true);
          steps.push('approval');
          return request;
        },
        notifyApprovalRequired: () => {steps.push('notify');},
      },
      orderService: {updateOrderItems: async (
        _id: string, _items: unknown, _user: string,
        options: {beforeCommit: (downgrade: object, tx: object) => Promise<unknown>},
      ) => {
        const approvalRequest = await options.beforeCommit({
          requestReason: 'removed add-on', removedLines: [], removedAddons: [{serviceId: 'addon'}],
        }, transaction);
        steps.push('commit');
        return {message: 'Order items updated.', approvalRequest};
      }},
    }) as OrderController;

    const result = await controller.updateOrderItems(
      {[securityId]: 'staff-1'} as never, 'order-1', {items: []} as never,
    );
    expect(result).to.containEql({message: 'Order items updated.', approvalRequest: request});
    expect(steps).to.eql(['approval', 'commit', 'notify']);
  });

  it('keeps a legacy pending request when the submitted items did not change', async () => {
    const transaction = {};
    let superseded = false;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      approvalRequestRepo: {find: async () => [{id: 'old-request', metadata: {desiredItems: []}}]},
      approvalService: {
        supersedeLegacyDowngrade: async () => {superseded = true;},
      },
      orderService: {updateOrderItems: async (
        _id: string, _items: unknown, _user: string,
        options: {trackItemChanges: boolean; beforeCommit: (
          downgrade: undefined, tx: object, changed: boolean,
        ) => Promise<unknown>},
      ) => {
        expect(options.trackItemChanges).to.equal(true);
        await options.beforeCommit(undefined, transaction, false);
        return {message: 'Order items updated.'};
      }},
    }) as OrderController;

    await controller.updateOrderItems(
      {[securityId]: 'staff-1'} as never, 'order-1', {items: []} as never,
    );
    expect(superseded).to.equal(false);
  });

  it('supersedes a legacy request when the saved items changed', async () => {
    const transaction = {};
    const request = {id: 'old-request', metadata: {desiredItems: []}};
    let supersededBy: string | undefined;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => {}},
      approvalRequestRepo: {find: async () => [request]},
      approvalService: {supersedeLegacyDowngrade: async (
        row: {id: string}, performedBy: string, tx: object,
      ) => {
        expect(row.id).to.equal(request.id);
        expect(tx).to.equal(transaction);
        supersededBy = performedBy;
      }},
      orderService: {updateOrderItems: async (
        _id: string, _items: unknown, _user: string,
        options: {beforeCommit: (
          downgrade: undefined, tx: object, changed: boolean,
        ) => Promise<unknown>},
      ) => {
        await options.beforeCommit(undefined, transaction, true);
        return {message: 'Order items updated.'};
      }},
    }) as OrderController;
    await controller.updateOrderItems(
      {[securityId]: 'staff-1'} as never, 'order-1', {items: []} as never,
    );
    expect(supersededBy).to.equal('staff-1');
  });

  it('records who superseded a legacy request when an item edit replaces it', async () => {
    const tx = {};
    const steps: string[] = [];
    const request = {id: 'old-request', metadata: {desiredItems: []}};
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {updateAll: async (data: {status: string; metadata: Record<string, unknown>},
        where: object, options: object) => {
        expect(data.status).to.equal(ApprovalRequestStatus.REJECTED);
        expect(data.metadata._supersededByOrderEdit).to.equal(true);
        expect(where).to.eql({id: request.id, status: ApprovalRequestStatus.PENDING});
        expect(options).to.eql({transaction: tx});
        steps.push('status');
        return {count: 1};
      }},
      approvalAuditLogRepo: {create: async (data: {eventType: string; performedBy: string}, options: object) => {
        expect(data.eventType).to.equal('superseded');
        expect(data.performedBy).to.equal('staff-1');
        expect(options).to.eql({transaction: tx});
        steps.push('audit');
      }},
    }) as ApprovalService;
    await service.supersedeLegacyDowngrade(request as never, 'staff-1', tx as never);
    expect(steps).to.eql(['status', 'audit']);
  });

  it('distinguishes an item change from regenerated child IDs and timestamps', async () => {
    let childId = 'old-child';
    let amount = 10;
    const row = (data: object) => ({toJSON: () => data});
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [row({id: 'item-1', serviceId: 'clean', quantity: 1,
        updatedAt: new Date()})]},
      orderItemChargeRepo: {find: async () => []},
      garmentRepo: {find: async () => [row({id: 'garment-1', orderItemId: 'item-1'})]},
      garmentAdditionalServiceRepo: {find: async () => [row({id: childId,
        garmentId: 'garment-1', serviceId: 'addon', amount, updatedAt: new Date()})]},
      garmentAdditionalChargeRepo: {find: async () => []},
    }) as OrderService;
    const signature = service as unknown as {orderItemEditSignature: (
      orderId: string, tx: object,
    ) => Promise<string>};
    const original = await signature.orderItemEditSignature('order-1', {});
    childId = 'new-child';
    expect(await signature.orderItemEditSignature('order-1', {})).to.equal(original);
    amount = 11;
    expect(await signature.orderItemEditSignature('order-1', {})).not.to.equal(original);
  });
});
