import {expect} from '@loopback/testlab';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {PickupRequestController} from '../controllers/pickup-request.controller';
import {PickupHandoverController} from '../controllers/pickup-handover.controller';
import {GarmentActionsController} from '../controllers/garment-actions.controller';
import {ApprovalController} from '../controllers/approval.controller';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {ReprocessReason} from '../models/reprocess-reason.enum';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {PickupHandoverStatus} from '../models/pickup-handover-status.enum';
import {PickupHandoverTargetType} from '../models/pickup-handover-target-type.enum';
import {ApprovalService} from '../services/approval.service';
import {OrderService} from '../services/order.service';
import {ReprocessService} from '../services/reprocess.service';

describe('reprocess approval is audit only', () => {
  it('locks the original order and rolls back when ticket creation fails', async () => {
    const steps: string[] = [];
    const transaction = {
      commit: async () => { steps.push('commit'); },
      rollback: async () => { steps.push('rollback'); },
    };
    const service = Object.assign(Object.create(ReprocessService.prototype), {
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: OrderStatus.DELIVERED}),
        findById: async () => ({id: 'order-1', status: OrderStatus.DELIVERED}),
      },
      dataSource: {
        beginTransaction: async () => transaction,
        execute: async (sql: string) => { expect(sql).to.match(/FOR UPDATE/); steps.push('lock'); },
      },
      assertWithinWindow: async () => {},
      resolveGarmentIds: async () => ['garment-1'],
      assertNoActiveReworkTicket: async () => { steps.push('check'); },
      approvalService: {
        createRequest: async (_input: unknown, tx: unknown) => {
          expect(tx).to.equal(transaction);
          steps.push('create');
          throw new Error('ticket write failed');
        },
      },
    }) as ReprocessService;

    await expect(service.raiseRequest({
      orderId: 'order-1', reason: ReprocessReason.OTHER, remarks: 'Stain remains',
      requestedBy: 'staff-1', source: 'store',
    })).to.be.rejectedWith(/ticket write failed/);
    expect(steps).to.deepEqual(['lock', 'check', 'create', 'rollback']);
  });

  it('does not reopen a delivered garment on its original order', async () => {
    let rolledBack = false;
    const controller = Object.assign(Object.create(GarmentActionsController.prototype), {
      storeScopeService: {assertGarmentEditable: async () => {}},
      dataSource: {
        beginTransaction: async () => ({rollback: async () => { rolledBack = true; }}),
        execute: async () => [],
      },
      garmentRepo: {findOne: async () => ({id: 'garment-1', status: GarmentStatus.DELIVERED})},
      approvalService: {createRequest: async () => { throw new Error('must not create request'); }},
    }) as GarmentActionsController;
    await expect(controller.requestReprocess({} as never, 'garment-1', {remarks: 'Stain remains'}))
      .to.be.rejectedWith(/Only an item still in the store/);
    expect(rolledBack).to.equal(true);
  });

  it('rolls back the garment audit request when resetting processing fails', async () => {
    const steps: string[] = [];
    const tx = {
      commit: async () => { steps.push('commit'); },
      rollback: async () => { steps.push('rollback'); },
    };
    const controller = Object.assign(Object.create(GarmentActionsController.prototype), {
      storeScopeService: {assertGarmentEditable: async () => {}},
      dataSource: {beginTransaction: async () => tx, execute: async () => { steps.push('lock'); }},
      garmentRepo: {findOne: async () => ({id: 'garment-1', status: GarmentStatus.READY})},
      approvalService: {
        createRequest: async (_input: unknown, transaction: unknown) => {
          expect(transaction).to.equal(tx);
          steps.push('audit');
          return {id: 'request-1'};
        },
        applyReprocessDirectly: async (_id: string, _by: string, _reason: string, transaction: unknown) => {
          expect(transaction).to.equal(tx);
          throw new Error('process reset failed');
        },
      },
    }) as GarmentActionsController;
    await expect(controller.requestReprocess({id: 'staff-1'} as never, 'garment-1', {remarks: 'Stain remains'}))
      .to.be.rejectedWith(/process reset failed/);
    expect(steps).to.eql(['lock', 'audit', 'rollback']);
  });

  it('marks reprocess as applied only when a reprocess history entry exists', async () => {
    let history: object | null = null;
    const controller = Object.assign(Object.create(ApprovalController.prototype), {
      approvalService: {resolveMedia: async () => []},
      garmentRepo: {findOne: async () => ({id: 'garment-1', status: GarmentStatus.IN_PROCESS})},
      garmentStatusHistoryRepo: {findOne: async () => history},
    }) as ApprovalController;
    const enrich = (controller as unknown as {
      enrichRequest: (request: ApprovalRequest) => Promise<{reprocessApplied: boolean}>;
    }).enrichRequest.bind(controller);
    const request = new ApprovalRequest({
      id: 'request-1', type: ApprovalRequestType.REPROCESS,
      entityType: 'garment', entityId: 'garment-1',
      requestedBy: 'staff-1', assignedToRole: 'store_exec',
      status: ApprovalRequestStatus.REJECTED,
    });
    expect((await enrich(request)).reprocessApplied).to.equal(false);
    history = {id: 'history-1'};
    expect((await enrich(request)).reprocessApplied).to.equal(true);
  });

  it('creates and returns the rework ticket when the audit request is created', async () => {
    let request: ApprovalRequest;
    const transaction = {} as NonNullable<Parameters<ApprovalService['createRequest']>[1]>;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      approvalRequestRepo: {
        create: async (data: Partial<ApprovalRequest>, options: {transaction: unknown}) => {
          expect(options.transaction).to.equal(transaction);
          request = new ApprovalRequest(data);
          return request;
        },
        findById: async (_id: string, _filter: unknown, options: {transaction: unknown}) => {
          expect(options.transaction).to.equal(transaction);
          return request;
        },
      },
      approvalAuditLogRepo: {create: async (_data: unknown, options: {transaction: unknown}) => {
        expect(options.transaction).to.equal(transaction);
      }},
      createPostDeliveryReprocessOrder: async (_request: unknown, _by: string, tx: unknown) => {
        expect(tx).to.equal(transaction);
        request.metadata = {...request.metadata, reworkOrderId: 'ticket-1'};
      },
    }) as ApprovalService;

    const created = await service.createRequest({
      type: ApprovalRequestType.REPROCESS, entityType: 'order', entityId: 'order-1',
      requestedBy: 'staff-1', metadata: {garmentIds: ['garment-1']},
    }, transaction);

    expect(created.status).to.equal(ApprovalRequestStatus.PENDING);
    expect(created.metadata?.reworkOrderId).to.equal('ticket-1');
  });

  it('creates a remote free ticket before any approval decision', async () => {
    let awaitingPickup: boolean | undefined;
    let savedMetadata: Record<string, unknown> = {};
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      orderService: {
        createReworkOrder: async (input: {awaitingPickup: boolean}) => {
          awaitingPickup = input.awaitingPickup;
          return {order: {id: 'ticket-1', orderNumber: 'RW-1'}, garmentsCreated: 0};
        },
      },
      approvalRequestRepo: {
        updateById: async (_id: string, input: {metadata: Record<string, unknown>}) => {
          savedMetadata = input.metadata;
        },
      },
      approvalAuditLogRepo: {create: async () => ({})},
    }) as ApprovalService;

    await service.createPostDeliveryReprocessOrder(new ApprovalRequest({
      id: 'request-1', entityId: 'order-1', requestReason: 'Stain remains',
      metadata: {garmentIds: ['garment-1'], contactChannel: 'phone'},
      type: ApprovalRequestType.REPROCESS, entityType: 'order',
      requestedBy: 'staff-1', assignedToRole: 'store_exec',
    }), 'staff-1');

    expect(awaitingPickup).to.equal(true);
    expect(savedMetadata.reworkOrderId).to.equal('ticket-1');
  });

  it('receives a remote ticket and creates its garments when pickup arrives', async () => {
    let status: OrderStatus = OrderStatus.CONFIRMED;
    let garmentsCreated = false;
    const tx = {commit: async () => {}, rollback: async () => {}};
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => []},
      orderRepo: {
        findOne: async () => ({status, reprocessOfOrderId: 'order-1', isDeleted: false}),
        updateById: async (_id: string, changes: {status: OrderStatus}) => { status = changes.status; },
      },
      autoCreateGarments: async (_id: string, _by: string, _v4: unknown, transaction: unknown) => {
        expect(transaction).to.equal(tx);
        garmentsCreated = true;
      },
      statusHistoryRepo: {create: async () => ({})},
    }) as OrderService;

    await service.receiveReworkOrder('ticket-1', 'staff-1');
    expect(status).to.equal(OrderStatus.RECEIVED_AT_STORE);
    expect(garmentsCreated).to.equal(true);
  });

  it('rejects a deleted rework ticket without receiving its pickup', async () => {
    let rolledBack = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => { rolledBack = true; }}),
        execute: async () => [],
      },
      orderRepo: {findOne: async () => null},
      autoCreateGarments: async () => { throw new Error('must not create garments'); },
    }) as OrderService;
    await expect(service.receiveReworkOrder('ticket-1', 'staff-1'))
      .to.be.rejectedWith(/Active rework ticket not found/);
    expect(rolledBack).to.equal(true);
  });

  it('rolls back the handover when a rework ticket cannot be received', async () => {
    const steps: string[] = [];
    const tx = {
      commit: async () => { steps.push('commit'); },
      rollback: async () => { steps.push('rollback'); },
    };
    const controller = Object.assign(Object.create(PickupHandoverController.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => { steps.push('lock'); }},
      handoverRepo: {findOne: async () => ({
        status: PickupHandoverStatus.PENDING,
        handoverToType: PickupHandoverTargetType.STORE,
      })},
      handoverItemRepo: {find: async () => [{pickupRequestId: 'pickup-1'}]},
      pickupRequestRepo: {
        findOne: async () => ({
          id: 'pickup-1', isReworkPickup: true,
          reworkOfOrderId: 'order-1', reworkApprovalRequestId: 'request-1',
        }),
        updateById: async () => { steps.push('pickup updated'); },
      },
      approvalRequestRepo: {findOne: async () => ({metadata: {reworkOrderId: 'ticket-1'}})},
      orderService: {receiveReworkOrder: async () => { throw new Error('ticket cancelled'); }},
    }) as PickupHandoverController;
    await expect(controller.confirm('handover-1', {} as never)).to.be.rejectedWith(/ticket cancelled/);
    expect(steps).to.eql(['lock', 'rollback']);
  });

  it('rolls back pickup receipt if a later bag update fails', async () => {
    const steps: string[] = [];
    const tx = {
      commit: async () => { steps.push('commit'); },
      rollback: async () => { steps.push('rollback'); },
    };
    const controller = Object.assign(Object.create(PickupHandoverController.prototype), {
      dataSource: {beginTransaction: async () => tx, execute: async () => {}},
      handoverRepo: {findOne: async () => ({
        status: PickupHandoverStatus.PENDING,
        handoverToType: PickupHandoverTargetType.STORE,
      })},
      handoverItemRepo: {find: async () => [{pickupRequestId: 'pickup-1'}]},
      pickupRequestRepo: {
        findOne: async () => ({id: 'pickup-1', bagId: 'bag-1'}),
        updateById: async (_id: string, _changes: unknown, options: {transaction: unknown}) => {
          expect(options.transaction).to.equal(tx);
          steps.push('pickup updated');
        },
      },
      bagRepo: {updateById: async () => { throw new Error('bag update failed'); }},
    }) as PickupHandoverController;
    await expect(controller.confirm('handover-1', {} as never)).to.be.rejectedWith(/bag update failed/);
    expect(steps).to.eql(['pickup updated', 'rollback']);
  });

  it('ignores rejected legacy requests without a ticket when checking overlap', async () => {
    const service = Object.assign(Object.create(ReprocessService.prototype), {
      approvalRequestRepo: {find: async () => [{
        status: ApprovalRequestStatus.REJECTED,
        metadata: {garmentIds: ['garment-1']},
      }]},
    }) as ReprocessService;
    const check = service as unknown as {
      assertNoActiveReworkTicket: (orderId: string, garmentIds: string[]) => Promise<void>;
    };
    await check.assertNoActiveReworkTicket('order-1', ['garment-1']);
  });

  it('schedules pickup while the audit decision is pending, but prevents a duplicate pickup', async () => {
    let existingPickup = false;
    const controller = Object.assign(Object.create(PickupRequestController.prototype), {
      approvalRequestRepository: {findOne: async () => ({
        id: 'request-1', status: ApprovalRequestStatus.PENDING,
        metadata: {reworkOrderId: 'ticket-1'},
      })},
      orderRepository: {findOne: async () => ({status: OrderStatus.CONFIRMED})},
      pickupRequestRepository: {
        findOne: async () => existingPickup ? {id: 'pickup-1'} : null,
        count: async () => ({count: 0}),
      },
      pickupRequestService: {createRequest: async () => ({id: 'pickup-1'})},
    }) as PickupRequestController;
    const input = {
      isReworkPickup: true, reworkOfOrderId: 'order-1', reworkApprovalRequestId: 'request-1',
      customerName: 'Customer', customerMobile: '9999999999', address: 'Home',
      requestedDate: '2026-10-25', slot: 'Morning', source: PickupRequestSource.WEB,
    };

    const result = await controller.create(input);
    expect((result as {pickupRequest: {id: string}}).pickupRequest.id).to.equal('pickup-1');
    existingPickup = true;
    await expect(controller.create(input)).to.be.rejectedWith(/pickup.*already exists/);
  });

  for (const action of [ApprovalActionType.APPROVED, ApprovalActionType.REJECTED]) {
    it(`records ${action} without applying workflow effects`, async () => {
      const request = {
        id: 'request-1', type: ApprovalRequestType.REPROCESS, entityType: 'order',
        entityId: 'order-1', status: ApprovalRequestStatus.PENDING, metadata: {reworkOrderId: 'ticket-1'},
      };
      const service = Object.assign(Object.create(ApprovalService.prototype), {
        approvalRequestRepo: {
          findById: async () => request,
          updateById: async (_id: string, changes: object) => Object.assign(request, changes),
        },
        approvalActionRepo: {create: async () => ({})},
        approvalAuditLogRepo: {create: async () => ({})},
        auditService: {log: async () => ({})},
        _captureSnapshot: async () => { throw new Error('snapshot should not run'); },
        _applyApproveEffect: async () => { throw new Error('approve effect should not run'); },
        _applyRejectEffect: async () => { throw new Error('reject effect should not run'); },
      }) as ApprovalService;

      const resolved = await service.resolve({requestId: request.id, action, performedBy: 'staff-1'});
      expect(resolved.status).to.equal(
        action === ApprovalActionType.APPROVED ? ApprovalRequestStatus.APPROVED : ApprovalRequestStatus.REJECTED,
      );
      expect(resolved.metadata?.reworkOrderId).to.equal('ticket-1');
      await expect(service.revert({requestId: request.id, performedBy: 'staff-1'}))
        .to.be.rejectedWith(/cannot be reverted/);
    });
  }
});
