import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PresstoDataSource} from '../datasources';
import {GarmentStatus} from '../models/garment-status.enum';
import {ProcessLogStatus} from '../models/process-log-status.enum';
import {
  GarmentProcessLogRepository,
  GarmentRepository,
  GarmentStatusHistoryRepository,
  OrderItemRepository,
  ProcessStepRepository,
  ServiceProcessMappingRepository,
  ServiceRepository,
} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class ProcessService {
  private qrScanRequired: boolean;

  constructor(
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(ServiceProcessMappingRepository) private spmRepo: ServiceProcessMappingRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(ProcessStepRepository) private processStepRepo: ProcessStepRepository,
    @repository(GarmentProcessLogRepository) private processLogRepo: GarmentProcessLogRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {
    this.qrScanRequired = process.env.QR_SCAN_REQUIRED === 'true';
  }

  // ─── Init Process ──────────────────────────────────────────────────────────
  // Creates pending log rows for all services × steps on this garment.
  // Call this when garment transitions to IN_PROCESS.

  async initProcess(garmentId: string, initiatedBy: string): Promise<object> {
    const {v4} = await import('uuid');

    const garment = await this.garmentRepo.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    if (garment.status !== GarmentStatus.IN_PROCESS) {
      throw new HttpErrors.BadRequest(
        `Garment must be in 'in_process' status to initialise processing. Current: ${garment.status}`,
      );
    }

    // Prevent double-init
    const existing = await this.processLogRepo.count({garmentId});
    if (existing.count > 0) {
      throw new HttpErrors.Conflict('Process already initialised for this garment.');
    }

    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) throw new HttpErrors.NotFound('Order item not found.');

    // Build ordered service list: primary first, then additional in array order
    const serviceIds: string[] = [
      orderItem.serviceId,
      ...(orderItem.additionalServiceIds ?? []),
    ];

    const created: object[] = [];

    for (let svcIdx = 0; svcIdx < serviceIds.length; svcIdx++) {
      const serviceId = serviceIds[svcIdx];
      const serviceSequence = svcIdx + 1;

      // Fetch steps for this service, ordered by sequence
      const mappings = await this.spmRepo.find({
        where: {serviceId, isActive: true, isDeleted: false} as any,
        order: ['sequence ASC'],
      });

      for (const mapping of mappings) {
        const log = await this.processLogRepo.create({
          id: v4(),
          garmentId,
          orderItemId: garment.orderItemId,
          serviceId,
          processStepId: mapping.processStepId,
          serviceSequence,
          stepSequence: mapping.sequence,
          status: ProcessLogStatus.PENDING,
        });
        created.push(log);
      }
    }

    if (!created.length) {
      throw new HttpErrors.UnprocessableEntity(
        'No process steps found for the services on this garment.',
      );
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
    const {v4} = await import('uuid');

    const garment = await this.garmentRepo.findOne({where: {id: garmentId, isDeleted: false}});
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
    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED' as any});

    try {
      // Fetch all logs ordered so we can find current state
      const allLogs = await this.processLogRepo.find({
        where: {garmentId} as any,
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
          {status: ProcessLogStatus.COMPLETED, completedAt: now, completedBy: performedBy},
          {transaction: tx},
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
          {transaction: tx},
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
        {status: GarmentStatus.QUALITY_CHECK},
        {transaction: tx},
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
        {transaction: tx},
      );

      await tx.commit();

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

  // ─── Process Status ────────────────────────────────────────────────────────

  async getProcessStatus(garmentId: string): Promise<object> {
    const garment = await this.garmentRepo.findOne({where: {id: garmentId, isDeleted: false}});
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');

    const logs = await this.processLogRepo.find({
      where: {garmentId} as any,
      order: ['serviceSequence ASC', 'stepSequence ASC'],
    });

    if (!logs.length) {
      return {
        garmentId,
        garmentTagNumber: garment.garmentTagNumber,
        status: garment.status,
        processInitialised: false,
        services: [],
      };
    }

    // Enrich with names
    const serviceIds = [...new Set(logs.map(l => l.serviceId))];
    const stepIds = [...new Set(logs.map(l => l.processStepId))];

    const [services, steps] = await Promise.all([
      this.serviceRepo.find({where: {id: {inq: serviceIds}} as any}),
      this.processStepRepo.find({where: {id: {inq: stepIds}} as any}),
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
    };
  }
}
