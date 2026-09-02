import { BindingScope, inject, injectable } from '@loopback/core';
import { repository } from '@loopback/repository';
import { HttpErrors } from '@loopback/rest';
import { PresstoDataSource } from '../datasources';
import { GarmentStatus } from '../models/garment-status.enum';
import { OrderItem } from '../models/order-item.model';
import { ProcessLogStatus } from '../models/process-log-status.enum';
import { OrderStatus } from '../models/order-status.enum';
import {
  GarmentProcessLogRepository,
  GarmentRepository,
  GarmentStatusHistoryRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  ProcessStepRepository,
  ServiceProcessMappingRepository,
  ServiceRepository,
  StoreRepository,
  TransferRepository,
} from '../repositories';

@injectable({ scope: BindingScope.TRANSIENT })
export class ProcessService {
  private qrScanRequired: boolean;
  private processingEnabled: boolean;

  constructor(
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderStatusHistoryRepository) private orderStatusHistoryRepo: OrderStatusHistoryRepository,
    @repository(ServiceProcessMappingRepository) private spmRepo: ServiceProcessMappingRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(ProcessStepRepository) private processStepRepo: ProcessStepRepository,
    @repository(GarmentProcessLogRepository) private processLogRepo: GarmentProcessLogRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(TransferRepository) private transferRepo: TransferRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {
    this.qrScanRequired = process.env.QR_SCAN_REQUIRED === 'true';
    // Default TRUE (enforced) — preserves today's real behavior for any
    // deployment that doesn't set this var. Explicitly set to 'false' to
    // allow the fast-track-to-ready bypass below.
    this.processingEnabled = process.env.PROCESSING_ENABLED !== 'false';
  }

  // ─── Init Process ──────────────────────────────────────────────────────────
  // Creates pending log rows for all services × steps on this garment.
  // Call this when garment transitions to IN_PROCESS.

  /**
   * The (serviceId, processStepId, serviceSequence, stepSequence) rows a
   * fresh process-log set for this garment's order item should contain —
   * the step-generation core of initProcess(), factored out so
   * completeAllProcesses() can reuse it to auto-initialise a garment whose
   * process was never started, instead of failing (see that method).
   */
  private async buildInitialLogRows(
    orderItem: OrderItem,
  ): Promise<Array<{ serviceId: string; processStepId: string; serviceSequence: number; stepSequence: number }>> {
    // Build ordered service list: primary first, then additional in array order
    const serviceIds: string[] = [
      orderItem.serviceId,
      ...(orderItem.additionalServiceIds ?? []),
    ];

    const rows: Array<{ serviceId: string; processStepId: string; serviceSequence: number; stepSequence: number }> = [];

    for (let svcIdx = 0; svcIdx < serviceIds.length; svcIdx++) {
      const serviceId = serviceIds[svcIdx];
      const serviceSequence = svcIdx + 1;

      // Fetch steps for this service, ordered by sequence
      const mappings = await this.spmRepo.find({
        where: { serviceId, isActive: true, isDeleted: false } as any,
        order: ['sequence ASC'],
      });

      for (const mapping of mappings) {
        rows.push({
          serviceId,
          processStepId: mapping.processStepId,
          serviceSequence,
          stepSequence: mapping.sequence,
        });
      }
    }

    return rows;
  }

  async initProcess(garmentId: string, _initiatedBy: string): Promise<object> {
    const { v4 } = await import('uuid');

    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    if (garment.status !== GarmentStatus.IN_PROCESS) {
      throw new HttpErrors.BadRequest(
        `Garment must be in 'in_process' status to initialise processing. Current: ${garment.status}`,
      );
    }

    // Prevent double-init
    const existing = await this.processLogRepo.count({ garmentId });
    if (existing.count > 0) {
      throw new HttpErrors.Conflict('Process already initialised for this garment.');
    }

    const orderItem = await this.orderItemRepo.findOne({ where: { id: garment.orderItemId } });
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    const rows = await this.buildInitialLogRows(orderItem);
    if (!rows.length) {
      throw new HttpErrors.UnprocessableEntity(
        'No process steps found for the services on this garment.',
      );
    }

    const created: object[] = [];
    for (const row of rows) {
      const log = await this.processLogRepo.create({
        id: v4(),
        garmentId,
        orderItemId: garment.orderItemId,
        ...row,
        status: ProcessLogStatus.PENDING,
      });
      created.push(log);
    }

    return {
      message: `Process initialised with ${created.length} step(s).`,
      steps: created,
    };
  }

  // ─── Advance Process ───────────────────────────────────────────────────────
  // Single call to advance one step:
  //   - If a step is IN_PROGRESS  → complete it.
  //   - Then find the next PENDING step → start it.
  //   - If no more steps            → mark garment QUALITY_CHECK.

  async advanceProcess(
    garmentId: string,
    performedBy: string,
    qrCode?: string,
  ): Promise<object> {
    const { v4 } = await import('uuid');

    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    // QR validation
    if (this.qrScanRequired) {
      if (!qrCode) {
        throw new HttpErrors.BadRequest('QR code is required (QR_SCAN_REQUIRED is enabled).');
      }
      const expected = garment.qrCode ?? garment.garmentTagNumber;
      if (qrCode !== expected) {
        throw new HttpErrors.BadRequest('QR code does not match this garment.');
      }
    }

    const now = new Date();
    const tx = await this.dataSource.beginTransaction({ isolationLevel: 'READ COMMITTED' as any });

    try {
      // Fetch all logs ordered so we can find current state
      const allLogs = await this.processLogRepo.find({
        where: { garmentId } as any,
        order: ['serviceSequence ASC', 'stepSequence ASC'],
      });

      if (!allLogs.length) {
        throw new HttpErrors.BadRequest(
          'Process not initialised for this garment. Call POST /garments/:id/process/init first.',
        );
      }

      const inProgressLog = allLogs.find(l => l.status === ProcessLogStatus.IN_PROGRESS);
      const nextPendingLog = allLogs.find(l => l.status === ProcessLogStatus.PENDING);

      // Complete the in-progress step
      if (inProgressLog) {
        await this.processLogRepo.updateById(
          inProgressLog.id,
          { status: ProcessLogStatus.COMPLETED, completedAt: now, completedBy: performedBy },
          { transaction: tx },
        );
      }

      if (nextPendingLog) {
        // Start the next step
        await this.processLogRepo.updateById(
          nextPendingLog.id,
          {
            status: ProcessLogStatus.IN_PROGRESS,
            startedAt: now,
            startedBy: performedBy,
            qrScanned: this.qrScanRequired || !!qrCode,
          },
          { transaction: tx },
        );

        await tx.commit();

        return {
          message: inProgressLog
            ? `Step completed. Started next step.`
            : `Started first step.`,
          completedStep: inProgressLog?.id ?? null,
          currentStep: nextPendingLog.id,
          allDone: false,
        };
      }

      // No more pending — all steps done
      if (!inProgressLog) {
        // Nothing was in progress and nothing pending — already finished or not started
        const allDone = allLogs.every(l => l.status === ProcessLogStatus.COMPLETED || l.status === ProcessLogStatus.SKIPPED);
        if (allDone) {
          throw new HttpErrors.Conflict('All process steps are already completed.');
        }
        throw new HttpErrors.BadRequest('No step is currently in progress. Re-check process state.');
      }

      // Last step just completed → move garment to QUALITY_CHECK
      await this.garmentRepo.updateById(
        garmentId,
        { status: GarmentStatus.QUALITY_CHECK },
        { transaction: tx },
      );
      await this.garmentStatusHistoryRepo.create(
        {
          id: v4(),
          garmentId,
          status: GarmentStatus.QUALITY_CHECK,
          changedAt: now,
          changedBy: performedBy,
          remarks: 'All process steps completed',
        },
        { transaction: tx },
      );

      await tx.commit();

      // Roll the order status up now that this garment finished processing.
      await this.syncOrderStatusFromGarment(garmentId, performedBy);

      return {
        message: 'All process steps completed. Garment moved to Quality Check.',
        completedStep: inProgressLog.id,
        currentStep: null,
        allDone: true,
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ─── Complete All Steps ───────────────────────────────────────────────────
  // "Mark all processes done" — closes every remaining step on the garment in
  // one go instead of advancing them one at a time, then moves the garment to
  // QUALITY_CHECK exactly as the final advance would.

  async completeAllProcesses(
    garmentId: string,
    performedBy: string,
    qrCode?: string,
  ): Promise<object> {
    const { v4 } = await import('uuid');

    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (garment.status !== GarmentStatus.IN_PROCESS) {
      throw new HttpErrors.BadRequest(
        `Garment must be in 'in_process' status to complete processing. Current: ${garment.status}`,
      );
    }

    // Same QR rule as a single advance — bulk must not be a way around it.
    if (this.qrScanRequired) {
      if (!qrCode) {
        throw new HttpErrors.BadRequest('QR code is required (QR_SCAN_REQUIRED is enabled).');
      }
      const expected = garment.qrCode ?? garment.garmentTagNumber;
      if (qrCode !== expected) {
        throw new HttpErrors.BadRequest('QR code does not match this garment.');
      }
    }

    const now = new Date();
    const tx = await this.dataSource.beginTransaction({ isolationLevel: 'READ COMMITTED' as any });

    try {
      let allLogs = await this.processLogRepo.find({
        where: { garmentId } as any,
        order: ['serviceSequence ASC', 'stepSequence ASC'],
      });

      // Never initialised (no advance/init call ever made for this garment) —
      // "mark all processed" should still work here rather than forcing a
      // separate init call first; initialise it now, in the same
      // transaction, then fall through to complete everything just created.
      if (!allLogs.length) {
        const orderItem = await this.orderItemRepo.findOne({ where: { id: garment.orderItemId } });
        if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

        const rows = await this.buildInitialLogRows(orderItem);
        if (!rows.length) {
          if (this.processingEnabled) {
            throw new HttpErrors.UnprocessableEntity(
              'No process steps found for the services on this garment.',
            );
          } else {
            await tx.commit();

            // Roll the order status up now that this garment finished processing.
            await this.syncOrderStatusFromGarment(garmentId, performedBy);

            return {
              message: 'All process steps completed. Garment moved to Quality Check.',
              stepsCompleted: 0,
              stepsTotal: allLogs.length,
              allDone: true,
            };
          }
        }

        allLogs = [];
        for (const row of rows) {
          const log = await this.processLogRepo.create(
            {
              id: v4(),
              garmentId,
              orderItemId: garment.orderItemId,
              ...row,
              status: ProcessLogStatus.PENDING,
            },
            { transaction: tx },
          );
          allLogs.push(log);
        }
      }

      const remaining = allLogs.filter(
        l => l.status === ProcessLogStatus.PENDING || l.status === ProcessLogStatus.IN_PROGRESS,
      );
      if (!remaining.length) {
        throw new HttpErrors.Conflict('All process steps are already completed.');
      }

      for (const log of remaining) {
        await this.processLogRepo.updateById(
          log.id,
          {
            status: ProcessLogStatus.COMPLETED,
            // A step closed straight from pending was never started — stamp it
            // now so the log still reads as a complete record.
            ...(log.startedAt ? {} : { startedAt: now, startedBy: performedBy }),
            completedAt: now,
            completedBy: performedBy,
            qrScanned: this.qrScanRequired || !!qrCode,
          },
          { transaction: tx },
        );
      }

      await this.garmentRepo.updateById(
        garmentId,
        { status: GarmentStatus.QUALITY_CHECK },
        { transaction: tx },
      );
      await this.garmentStatusHistoryRepo.create(
        {
          id: v4(),
          garmentId,
          status: GarmentStatus.QUALITY_CHECK,
          changedAt: now,
          changedBy: performedBy,
          remarks: 'All process steps marked done',
        },
        { transaction: tx },
      );

      await tx.commit();

      // Roll the order status up now that this garment finished processing.
      await this.syncOrderStatusFromGarment(garmentId, performedBy);

      return {
        message: 'All process steps completed. Garment moved to Quality Check.',
        stepsCompleted: remaining.length,
        stepsTotal: allLogs.length,
        allDone: true,
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ─── Fast-Track to Ready (processing-disabled bypass) ─────────────────────
  // When PROCESSING_ENABLED=false, staff can skip the stage-by-stage flow
  // entirely: auto-complete every remaining step (same logic as
  // completeAllProcesses above) and then take the one further
  // quality_check -> ready hop that's normally a separate, unrelated action
  // (GarmentActionsController's generic status update).

  async fastTrackToReady(garmentId: string, performedBy: string, qrCode?: string): Promise<object> {
    if (this.processingEnabled) {
      throw new HttpErrors.BadRequest('Processing is enabled — follow the standard stage-by-stage flow.');
    }

    const { v4 } = await import('uuid');
    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    if (garment.status !== GarmentStatus.IN_PROCESS && garment.status !== GarmentStatus.QUALITY_CHECK) {
      throw new HttpErrors.BadRequest(
        `Garment must be in 'in_process' or 'quality_check' status to fast-track to ready. Current: '${garment.status}'.`,
      );
    }

    let stepsCompleted = 0;
    if (garment.status === GarmentStatus.IN_PROCESS) {
      const result = (await this.completeAllProcesses(garmentId, performedBy, qrCode)) as { stepsCompleted: number };
      stepsCompleted = result.stepsCompleted;
    }

    const now = new Date();
    await this.garmentRepo.updateById(garmentId, { status: GarmentStatus.READY, readyForDispatch: true });
    await this.garmentStatusHistoryRepo.create({
      id: v4(),
      garmentId,
      status: GarmentStatus.READY,
      changedAt: now,
      changedBy: performedBy,
      remarks: 'Fast-tracked to ready — processing disabled (PROCESSING_ENABLED=false)',
    });

    await this.syncOrderStatusFromGarment(garmentId, performedBy);

    const updated = await this.garmentRepo.findOne({ where: { id: garmentId } });
    return {
      message: 'Garment fast-tracked to ready.',
      stepsCompleted,
      garment: updated,
    };
  }

  // ─── Processing Config ──────────────────────────────────────────────────────

  getConfig(): { processingEnabled: boolean } {
    return { processingEnabled: this.processingEnabled };
  }

  // ─── Reverse Last Step ────────────────────────────────────────────────────
  // Marks the most recent completed step back to pending, re-opens it.
  // Also resets the garment to IN_PROCESS if it had advanced to QUALITY_CHECK.

  async reverseStep(garmentId: string, performedBy: string): Promise<object> {
    const { v4 } = await import('uuid');

    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const allLogs = await this.processLogRepo.find({
      where: { garmentId } as any,
      order: ['serviceSequence ASC', 'stepSequence ASC'],
    });

    if (!allLogs.length) {
      throw new HttpErrors.BadRequest('Process not initialised for this garment.');
    }

    // Find the last completed step
    const completedLogs = allLogs.filter(l => l.status === ProcessLogStatus.COMPLETED);
    if (!completedLogs.length) {
      throw new HttpErrors.BadRequest('No completed step to reverse.');
    }

    const lastCompleted = completedLogs[completedLogs.length - 1];

    // Clear any in-progress step first (set back to pending)
    const inProgressLog = allLogs.find(l => l.status === ProcessLogStatus.IN_PROGRESS);
    if (inProgressLog) {
      await this.processLogRepo.updateById(inProgressLog.id, {
        status: ProcessLogStatus.PENDING,
        startedAt: undefined,
        startedBy: undefined,
        qrScanned: false,
      } as any);
    }

    // Reverse the last completed step
    await this.processLogRepo.updateById(lastCompleted.id, {
      status: ProcessLogStatus.IN_PROGRESS,
      completedAt: undefined,
      completedBy: undefined,
      startedAt: new Date(),
      startedBy: performedBy,
    } as any);

    // If garment moved to QUALITY_CHECK, bring it back to IN_PROCESS
    if (garment.status === GarmentStatus.QUALITY_CHECK) {
      await this.garmentRepo.updateById(garmentId, { status: GarmentStatus.IN_PROCESS });
      await this.garmentStatusHistoryRepo.create({
        id: v4(),
        garmentId,
        status: GarmentStatus.IN_PROCESS,
        changedAt: new Date(),
        changedBy: performedBy,
        remarks: 'Step reversed — garment returned to in_process',
      });
    }

    // Keep the order status in sync with the garment pipeline.
    await this.syncOrderStatusFromGarment(garmentId, performedBy);

    return {
      message: 'Last completed step reversed.',
      reversedStepId: lastCompleted.id,
    };
  }

  // ─── Order status sync ──────────────────────────────────────────────────────
  // Process operations update garment status directly (bypassing the garment
  // status endpoint), so they must roll the ORDER status too. The order status
  // is the pipeline bottleneck: the minimum rank among all active garments.
  // Mirrors GarmentController.syncOrderStatus.

  async syncOrderStatusFromGarment(garmentId: string, changedBy: string): Promise<void> {
    const { v4 } = await import('uuid');

    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) return;
    const anchorItem = await this.orderItemRepo.findOne({ where: { id: garment.orderItemId } });
    if (!anchorItem) return;
    const order = await this.orderRepo.findOne({ where: { id: anchorItem.orderId, isDeleted: false } });
    if (!order) return;

    // All garments across every item of this order
    const orderItems = await this.orderItemRepo.find({ where: { orderId: order.id } });
    const orderItemIds = orderItems.map(oi => oi.id);
    const garments = await this.garmentRepo.find({
      where: { orderItemId: { inq: orderItemIds }, isDeleted: false } as any,
    });

    const STATUS_RANK: Record<string, number> = {
      [GarmentStatus.RECEIVED]: 0,
      [GarmentStatus.IN_INSPECTION]: 1,
      [GarmentStatus.IN_PROCESS]: 2,
      [GarmentStatus.QUALITY_CHECK]: 3,
      [GarmentStatus.READY]: 4,
      [GarmentStatus.OUT_FOR_DELIVERY]: 5,
      [GarmentStatus.DELIVERED]: 6,
      [GarmentStatus.ON_HOLD]: -1,
      [GarmentStatus.RETURNED_TO_CUSTOMER]: -1,
    };
    const RANK_TO_ORDER_STATUS: Record<number, OrderStatus> = {
      0: OrderStatus.RECEIVED_AT_STORE,
      1: OrderStatus.IN_INSPECTION,
      2: OrderStatus.IN_PROCESS,
      3: OrderStatus.QUALITY_CHECK,
      4: OrderStatus.READY,
      5: OrderStatus.OUT_FOR_DELIVERY,
      6: OrderStatus.DELIVERED,
    };

    const now = new Date();
    const setOrderStatus = async (status: OrderStatus, remarks: string) => {
      if (order.status === status) return;
      await this.orderRepo.updateById(order.id, { status });
      await this.orderStatusHistoryRepo.create({
        id: v4(), orderId: order.id, status, changedAt: now, changedBy, remarks,
      });
    };

    // Active = anything still in the pipeline (exclude on_hold / returned)
    const activeStatuses = garments
      .map(g => g.status as GarmentStatus)
      .filter(s => (STATUS_RANK[s] ?? -1) >= 0);

    if (activeStatuses.length === 0) {
      await setOrderStatus(OrderStatus.CANCELLED, 'Auto-cancelled: all garments returned/on hold');
      return;
    }

    const minRank = Math.min(...activeStatuses.map(s => STATUS_RANK[s] ?? 0));
    const derived = RANK_TO_ORDER_STATUS[minRank];
    if (derived) {
      await setOrderStatus(derived, 'Auto-synced from garment processing pipeline');
    }
  }

  // ─── Garment Tracking ──────────────────────────────────────────────────────
  // Where this garment physically is right now, and the inter-store transfer
  // (if any) currently holding it — same "home store, unless an active
  // transfer holds it elsewhere" rule garment.controller.ts's scan lookup
  // already uses, but returning the full transfer record (not just an id)
  // so a caller can show route + live status, not just a location.

  private async resolveGarmentTracking(garment: {
    orderItemId: string;
    activeTransferId?: string | null;
  }): Promise<object> {
    const orderItem = await this.orderItemRepo.findOne({ where: { id: garment.orderItemId } });
    const order = orderItem?.orderId
      ? await this.orderRepo.findOne({ where: { id: orderItem.orderId } })
      : null;
    const homeStoreId = order?.storeId ?? null;

    const transfer = garment.activeTransferId
      ? await this.transferRepo.findOne({ where: { id: garment.activeTransferId } })
      : null;

    const storeIds = [...new Set([homeStoreId, transfer?.fromStoreId, transfer?.toStoreId].filter(Boolean))] as string[];
    const stores = storeIds.length ? await this.storeRepo.find({ where: { id: { inq: storeIds } } }) : [];
    const storeNameById = new Map(stores.map(s => [s.id, s.name ?? null]));

    const currentStoreId = transfer ? transfer.toStoreId : homeStoreId;

    return {
      homeStoreId,
      homeStoreName: homeStoreId ? storeNameById.get(homeStoreId) ?? null : null,
      currentStoreId,
      currentStoreName: currentStoreId ? storeNameById.get(currentStoreId) ?? null : null,
      activeTransfer: transfer
        ? {
          id: transfer.id,
          transitId: transfer.transitId,
          status: transfer.status,
          fromStoreId: transfer.fromStoreId,
          fromStoreName: storeNameById.get(transfer.fromStoreId) ?? null,
          toStoreId: transfer.toStoreId,
          toStoreName: storeNameById.get(transfer.toStoreId) ?? null,
          sentAt: transfer.sentAt ?? null,
          inTransitAt: transfer.inTransitAt ?? null,
          receivedAt: transfer.receivedAt ?? null,
        }
        : null,
    };
  }

  // ─── Process Status ────────────────────────────────────────────────────────

  async getProcessStatus(garmentId: string): Promise<object> {
    const garment = await this.garmentRepo.findOne({ where: { id: garmentId, isDeleted: false } });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const [logs, tracking] = await Promise.all([
      this.processLogRepo.find({
        where: { garmentId } as any,
        order: ['serviceSequence ASC', 'stepSequence ASC'],
      }),
      this.resolveGarmentTracking(garment),
    ]);

    if (!logs.length) {
      return {
        garmentId,
        garmentTagNumber: garment.garmentTagNumber,
        status: garment.status,
        processInitialised: false,
        services: [],
        tracking,
      };
    }

    // Enrich with names
    const serviceIds = [...new Set(logs.map(l => l.serviceId))];
    const stepIds = [...new Set(logs.map(l => l.processStepId))];

    const [services, steps] = await Promise.all([
      this.serviceRepo.find({ where: { id: { inq: serviceIds } } as any }),
      this.processStepRepo.find({ where: { id: { inq: stepIds } } as any }),
    ]);

    const serviceMap = new Map(services.map(s => [s.id, s]));
    const stepMap = new Map(steps.map(s => [s.id, s]));

    // Group logs by serviceSequence
    const serviceGroups = new Map<number, typeof logs>();
    for (const log of logs) {
      const group = serviceGroups.get(log.serviceSequence) ?? [];
      group.push(log);
      serviceGroups.set(log.serviceSequence, group);
    }

    const serviceList = [];
    for (const [seq, groupLogs] of [...serviceGroups.entries()].sort((a, b) => a[0] - b[0])) {
      const serviceId = groupLogs[0].serviceId;
      const svc = serviceMap.get(serviceId);

      const allCompleted = groupLogs.every(l => l.status === ProcessLogStatus.COMPLETED || l.status === ProcessLogStatus.SKIPPED);
      const anyInProgress = groupLogs.some(l => l.status === ProcessLogStatus.IN_PROGRESS);

      serviceList.push({
        serviceSequence: seq,
        serviceId,
        serviceName: svc?.name ?? null,
        status: allCompleted ? 'completed' : anyInProgress ? 'in_progress' : 'pending',
        steps: groupLogs.map(log => ({
          id: log.id,
          processStepId: log.processStepId,
          stepName: stepMap.get(log.processStepId)?.name ?? null,
          stepSequence: log.stepSequence,
          status: log.status,
          startedAt: log.startedAt ?? null,
          completedAt: log.completedAt ?? null,
          qrScanned: log.qrScanned ?? false,
        })),
      });
    }

    const overallDone = serviceList.every(s => s.status === 'completed');
    const currentStep = logs.find(l => l.status === ProcessLogStatus.IN_PROGRESS) ?? null;

    return {
      garmentId,
      garmentTagNumber: garment.garmentTagNumber,
      garmentStatus: garment.status,
      processInitialised: true,
      allDone: overallDone,
      qrScanRequired: this.qrScanRequired,
      currentStep: currentStep
        ? {
          id: currentStep.id,
          serviceSequence: currentStep.serviceSequence,
          stepSequence: currentStep.stepSequence,
          stepName: stepMap.get(currentStep.processStepId)?.name ?? null,
        }
        : null,
      services: serviceList,
      tracking,
    };
  }
}
