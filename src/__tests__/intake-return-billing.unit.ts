/* eslint-disable @typescript-eslint/no-explicit-any -- Repository stubs use partial records. */
import {expect} from '@loopback/testlab';
import {securityId} from '@loopback/security';
import {IntakeRejectionController} from '../controllers/intake-rejection.controller';
import {IntakeRejectionReason} from '../models/intake-rejected-item.model';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';

describe('direct intake return billing', () => {
  const dataSource = {
    beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
    execute: async () => {},
  };

  it('applies return billing before recording the intake return', async () => {
    const garment = {id: 'garment-1', status: GarmentStatus.RECEIVED};
    const calls: string[] = [];
    const controller = Object.assign(
      Object.create(IntakeRejectionController.prototype),
      {
        orderRepo: {findOne: async () => ({id: 'order-1'})},
        orderItemRepo: {findOne: async () => ({id: 'item-1'})},
        garmentRepo: {findOne: async () => garment},
        dataSource,
        approvalService: {
          createRequest: async (request: any) => {
            calls.push('return billing');
            expect(request.type).to.equal(ApprovalRequestType.RETURN_ITEM);
            expect(request.entityId).to.equal(garment.id);
            expect(request.metadata.source).to.equal('direct_intake_return');
            garment.status = GarmentStatus.RETURNED_TO_CUSTOMER;
            return {id: 'approval-1'};
          },
          resolve: async (decision: any) => {
            calls.push('resolve');
            expect(decision.requestId).to.equal('approval-1');
            expect(decision.action).to.equal(ApprovalActionType.APPROVED);
          },
        },
        intakeRejectedRepo: {create: async (record: any) => {
          calls.push('intake record');
          return record;
        }},
        challanRepo: {findOne: async () => ({id: 'challan-1'})},
        orderService: {
          syncChallanTotalsForOrder: async () => { calls.push('challan'); },
        },
      },
    ) as IntakeRejectionController;

    await controller.rejectItem(
      {[securityId]: 'staff-1'} as any,
      'order-1',
      'item-1',
      {
        reason: IntakeRejectionReason.OTHER,
        garmentId: garment.id,
        directReturn: true,
      },
    );

    expect(garment.status).to.equal(GarmentStatus.RETURNED_TO_CUSTOMER);
    expect(calls).to.eql(['return billing', 'resolve', 'intake record', 'challan']);
  });

  it('returns the existing intake record when the request is retried', async () => {
    const existing = {id: 'intake-1'};
    const controller = Object.assign(Object.create(IntakeRejectionController.prototype), {
      orderRepo: {findOne: async () => ({id: 'order-1'})},
      orderItemRepo: {findOne: async () => ({id: 'item-1'})},
      garmentRepo: {findOne: async () => ({id: 'garment-1', status: GarmentStatus.RETURNED_TO_CUSTOMER})},
      dataSource,
      approvalService: {createRequest: async () => { throw new Error('duplicate billing'); }},
      intakeRejectedRepo: {findOne: async () => existing},
      challanRepo: {findOne: async () => null},
    }) as IntakeRejectionController;

    const result = await controller.rejectItem(
      {[securityId]: 'staff-1'} as any, 'order-1', 'item-1',
      {reason: IntakeRejectionReason.OTHER, garmentId: 'garment-1', directReturn: true},
    ) as {record: {id: string}};

    expect(result.record).to.equal(existing);
  });

  it('serializes simultaneous returns so billing runs once', async () => {
    const garment = {id: 'garment-1', status: GarmentStatus.RECEIVED};
    const existing = {id: 'intake-1'};
    let billingCalls = 0;
    let record: any;
    let lock = Promise.resolve();
    const concurrentDataSource = {
      beginTransaction: async () => {
        let release = () => {};
        return {
          acquire: async () => {
            const previous = lock;
            lock = new Promise<void>((resolve) => { release = resolve; });
            await previous;
          },
          commit: async () => release(),
          rollback: async () => release(),
        };
      },
      execute: async (_sql: string, _params: unknown[], options: any) =>
        options.transaction.acquire(),
    };
    const controller = Object.assign(Object.create(IntakeRejectionController.prototype), {
      orderRepo: {findOne: async () => ({id: 'order-1'})},
      orderItemRepo: {findOne: async () => ({id: 'item-1'})},
      garmentRepo: {findOne: async () => garment},
      dataSource: concurrentDataSource,
      approvalService: {
        createRequest: async () => {
          billingCalls += 1;
          garment.status = GarmentStatus.RETURNED_TO_CUSTOMER;
          return {id: 'approval-1'};
        },
        resolve: async () => {},
      },
      intakeRejectedRepo: {
        findOne: async () => record,
        create: async () => { record = existing; return record; },
      },
      challanRepo: {findOne: async () => null},
    }) as IntakeRejectionController;

    const input = {reason: IntakeRejectionReason.OTHER, garmentId: garment.id, directReturn: true};
    const results = await Promise.all([
      controller.rejectItem({[securityId]: 'staff-1'} as any, 'order-1', 'item-1', input),
      controller.rejectItem({[securityId]: 'staff-2'} as any, 'order-1', 'item-1', input),
    ]) as Array<{record: {id: string}}>;

    expect(billingCalls).to.equal(1);
    expect(results.map(result => result.record.id)).to.eql(['intake-1', 'intake-1']);
  });

  it('finishes an interrupted return without billing it again', async () => {
    const garment = {id: 'garment-1', status: GarmentStatus.RECEIVED};
    const approval = {id: 'approval-1', status: 'pending', metadata: {source: 'direct_intake_return'}};
    let billingCalls = 0;
    let recordWrites = 0;
    let challanSyncs = 0;
    const controller = Object.assign(Object.create(IntakeRejectionController.prototype), {
      orderRepo: {findOne: async () => ({id: 'order-1'})},
      orderItemRepo: {findOne: async () => ({id: 'item-1'})},
      garmentRepo: {findOne: async () => garment},
      dataSource,
      approvalRequestRepo: {find: async () => [approval]},
      approvalService: {
        createRequest: async () => {
          billingCalls += 1;
          garment.status = GarmentStatus.RETURNED_TO_CUSTOMER;
          return approval;
        },
        resolve: async () => { approval.status = 'approved'; },
      },
      intakeRejectedRepo: {
        findOne: async () => null,
        create: async (value: any) => {
          recordWrites += 1;
          if (recordWrites === 1) throw new Error('intake write failed');
          return value;
        },
      },
      challanRepo: {findOne: async () => ({id: 'challan-1'})},
      orderService: {syncChallanTotalsForOrder: async () => { challanSyncs += 1; }},
    }) as IntakeRejectionController;
    const input = {reason: IntakeRejectionReason.OTHER, garmentId: garment.id, directReturn: true};

    await expect(controller.rejectItem(
      {[securityId]: 'staff-1'} as any, 'order-1', 'item-1', input,
    )).to.be.rejectedWith('intake write failed');
    const result = await controller.rejectItem(
      {[securityId]: 'staff-1'} as any, 'order-1', 'item-1', input,
    ) as {record: {garmentId: string}};

    expect(billingCalls).to.equal(1);
    expect(recordWrites).to.equal(2);
    expect(challanSyncs).to.equal(1);
    expect(result.record.garmentId).to.equal(garment.id);
  });
});
