import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ApprovalActionRepository} from '../repositories/approval-action.repository';
import {ApprovalAuditLogRepository} from '../repositories/approval-audit-log.repository';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {GarmentRepository} from '../repositories/garment.repository';
import {GarmentStatusHistoryRepository} from '../repositories/garment-status-history.repository';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {APPROVAL_ROLE_ROUTING, ApprovalRequest} from '../models/approval-request.model';
import {AuditService} from './audit.service';

const GARMENT_STATUS_ON_APPROVAL: Partial<Record<ApprovalRequestType, GarmentStatus>> = {
  [ApprovalRequestType.RETURN_ITEM]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.ITEM_DAMAGED]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.REPROCESS]: GarmentStatus.IN_PROCESS,
};

@injectable({scope: BindingScope.TRANSIENT})
export class ApprovalService {
  constructor(
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalActionRepository) private approvalActionRepo: ApprovalActionRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @inject('services.audit') private auditService: AuditService,
  ) {}

  async createRequest(params: {
    type: ApprovalRequestType;
    entityType: string;
    entityId: string;
    requestedBy: string;
    requestReason?: string;
  }): Promise<ApprovalRequest> {
    const {v4} = await import('uuid');
    const assignedToRole = APPROVAL_ROLE_ROUTING[params.type];

    const request = await this.approvalRequestRepo.create({
      id: v4(),
      type: params.type,
      entityType: params.entityType,
      entityId: params.entityId,
      requestedBy: params.requestedBy,
      assignedToRole,
      status: ApprovalRequestStatus.PENDING,
      requestReason: params.requestReason,
    });

    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: request.id,
      eventType: 'created',
      remarks: `Request created for ${params.type} on ${params.entityType} ${params.entityId}`,
      performedBy: params.requestedBy,
    });

    return request;
  }

  async resolve(params: {
    requestId: string;
    action: ApprovalActionType;
    performedBy: string;
    comments?: string;
  }): Promise<ApprovalRequest> {
    const request = await this.approvalRequestRepo.findById(params.requestId);
    if (request.status !== ApprovalRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Approval request is already ${request.status}.`);
    }

    const newStatus =
      params.action === ApprovalActionType.APPROVED
        ? ApprovalRequestStatus.APPROVED
        : ApprovalRequestStatus.REJECTED;

    const {v4} = await import('uuid');

    await this.approvalActionRepo.create({
      id: v4(),
      approvalRequestId: params.requestId,
      action: params.action,
      performedBy: params.performedBy,
      comments: params.comments,
    });

    await this.approvalRequestRepo.updateById(params.requestId, {
      status: newStatus,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    });

    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: params.requestId,
      eventType: params.action,
      remarks: params.comments,
      performedBy: params.performedBy,
    });

    const resolved = await this.approvalRequestRepo.findById(params.requestId);

    // Write to general audit log so the entity's full history is queryable in one place
    await this.auditService.log({
      entityType: request.entityType,
      entityId: request.entityId,
      actionType: `approval_${params.action}`,
      performedBy: params.performedBy,
      before: {approvalStatus: ApprovalRequestStatus.PENDING},
      after: {approvalStatus: newStatus, approvalRequestId: params.requestId},
      remarks: params.comments,
    });

    // Apply downstream effect when approved
    if (params.action === ApprovalActionType.APPROVED) {
      await this.applyApprovalEffect(request, params.performedBy);
    }

    return resolved;
  }

  private async applyApprovalEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    if (request.entityType !== 'garment') return;

    const newStatus = GARMENT_STATUS_ON_APPROVAL[request.type];
    if (!newStatus) return;

    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    if (!garment) return;

    const {v4} = await import('uuid');
    await this.garmentRepo.updateById(request.entityId, {status: newStatus});
    await this.garmentStatusHistoryRepo.create({
      id: v4(),
      garmentId: request.entityId,
      status: newStatus,
      changedAt: new Date(),
      changedBy: performedBy,
      remarks: `Auto-updated via approval: ${request.type}`,
    });
  }
}
