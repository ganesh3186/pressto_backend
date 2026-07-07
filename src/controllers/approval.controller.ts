import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository, Where} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequest} from '../models/approval-request.model';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {ApprovalAuditLogRepository} from '../repositories/approval-audit-log.repository';
import {ApprovalService} from '../services/approval.service';

export class ApprovalController {
  constructor(
    @inject('services.approval') private approvalService: ApprovalService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
  ) {}

  // ─── Create Approval Request ──────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/approval-requests')
  @response(200, {description: 'Approval request created'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['type', 'entityType', 'entityId'],
            properties: {
              type: {type: 'string', enum: Object.values(ApprovalRequestType)},
              entityType: {type: 'string', enum: ['order', 'garment', 'payment']},
              entityId: {type: 'string', format: 'uuid'},
              requestReason: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      type: ApprovalRequestType;
      entityType: string;
      entityId: string;
      requestReason?: string;
    },
  ): Promise<object> {
    const request = await this.approvalService.createRequest({
      ...body,
      requestedBy: currentUser[securityId],
    });
    return {message: 'Approval request created.', request};
  }

  // ─── Resolve (Approve / Reject) ───────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:create']})
  @post('/approval-requests/{id}/resolve')
  @response(200, {description: 'Approval request resolved'})
  async resolve(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: {type: 'string', enum: Object.values(ApprovalActionType)},
              comments: {type: 'string'},
            },
          },
        },
      },
    })
    body: {action: ApprovalActionType; comments?: string},
  ): Promise<object> {
    const updated = await this.approvalService.resolve({
      requestId: id,
      action: body.action,
      performedBy: currentUser[securityId],
      comments: body.comments,
    });
    return {message: `Request ${body.action}.`, request: updated};
  }

  // ─── List Approval Requests ───────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:read']})
  @get('/approval-requests')
  @response(200, {description: 'List of approval requests'})
  async list(
    @param.query.string('status') status?: ApprovalRequestStatus,
    @param.query.string('type') type?: ApprovalRequestType,
    @param.query.string('entityType') entityType?: string,
    @param.query.string('entityId') entityId?: string,
    @param.query.string('assignedToRole') assignedToRole?: string,
  ): Promise<object> {
    const where: Where<ApprovalRequest> = {};
    if (status) (where as Record<string, unknown>).status = status;
    if (type) (where as Record<string, unknown>).type = type;
    if (entityType) (where as Record<string, unknown>).entityType = entityType;
    if (entityId) (where as Record<string, unknown>).entityId = entityId;
    if (assignedToRole) (where as Record<string, unknown>).assignedToRole = assignedToRole;

    const requests = await this.approvalRequestRepo.find({
      where,
      order: ['createdAt DESC'],
    });
    return {requests};
  }

  // ─── Get Single Request + Audit Trail ────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:read']})
  @get('/approval-requests/{id}')
  @response(200, {description: 'Approval request detail with audit trail'})
  async getById(@param.path.string('id') id: string): Promise<object> {
    const request = await this.approvalRequestRepo.findOne({where: {id}});
    if (!request) throw new HttpErrors.NotFound('Approval request not found.');

    const auditLog = await this.approvalAuditLogRepo.find({
      where: {approvalRequestId: id},
      order: ['performedAt ASC'],
    });

    return {request, auditLog};
  }
}
