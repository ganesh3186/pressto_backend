import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ApprovalActionRepository} from '../repositories/approval-action.repository';
import {ApprovalAuditLogRepository} from '../repositories/approval-audit-log.repository';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {APPROVAL_ROLE_ROUTING, ApprovalRequest} from '../models/approval-request.model';

@injectable({scope: BindingScope.TRANSIENT})
export class ApprovalService {
  constructor(
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalActionRepository) private approvalActionRepo: ApprovalActionRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
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

    return this.approvalRequestRepo.findById(params.requestId);
  }
}
