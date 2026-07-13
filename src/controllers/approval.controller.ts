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
import {GarmentRepository, OrderItemRepository, OrderRepository, ItemRepository} from '../repositories';
import {ApprovalService} from '../services/approval.service';

export class ApprovalController {
  constructor(
    @inject('services.approval') private approvalService: ApprovalService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
  ) {}

  private async enrichRequest(req: ApprovalRequest): Promise<object> {
    if (req.entityType !== 'garment') return req;

    const garment = await this.garmentRepo.findOne({where: {id: req.entityId}});
    if (!garment) return req;

    const orderItem = garment.orderItemId
      ? await this.orderItemRepo.findOne({where: {id: garment.orderItemId}})
      : null;

    const [order, item] = await Promise.all([
      orderItem?.orderId ? this.orderRepo.findOne({where: {id: orderItem.orderId}}) : Promise.resolve(null),
      orderItem?.itemId ? this.itemRepo.findOne({where: {id: orderItem.itemId}}) : Promise.resolve(null),
    ]);

    return {
      ...req,
      garmentTag: garment.garmentTagNumber,
      garmentStatus: garment.status,
      itemName: item?.name ?? null,
      orderNumber: (order as any)?.orderNumber ?? null,
      orderId: orderItem?.orderId ?? null,
    };
  }

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
              // Already-uploaded media UUIDs as evidence for the request
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              // Type-specific extra data — e.g. { toServiceId } for upgrade_service
              metadata: {type: 'object'},
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
      mediaIds?: string[];
      metadata?: Record<string, unknown>;
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
              // Evidence images uploaded when resolving
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              // How approval was obtained: direct | on_call | in_person | whatsapp | email
              approvalSource: {type: 'string', enum: ['direct', 'on_call', 'in_person', 'whatsapp', 'email']},
              // If a staff member approved on behalf of the customer
              onBehalfOfCustomerId: {type: 'string', format: 'uuid'},
            },
          },
        },
      },
    })
    body: {
      action: ApprovalActionType;
      comments?: string;
      mediaIds?: string[];
      approvalSource?: string;
      onBehalfOfCustomerId?: string;
    },
  ): Promise<object> {
    const updated = await this.approvalService.resolve({
      requestId: id,
      action: body.action,
      performedBy: currentUser[securityId],
      comments: body.comments,
      mediaIds: body.mediaIds,
      approvalSource: body.approvalSource,
      onBehalfOfCustomerId: body.onBehalfOfCustomerId,
    });
    return {message: `Request ${body.action}.`, request: updated};
  }

  // ─── Revert (undo a resolved decision) ────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:update']})
  @post('/approval-requests/{id}/revert')
  @response(200, {description: 'Approval request reverted to pending'})
  async revert(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: {type: 'string', description: 'Why the decision is being undone'},
            },
          },
        },
      },
    })
    body?: {reason?: string},
  ): Promise<object> {
    const {request, notes} = await this.approvalService.revert({
      requestId: id,
      performedBy: currentUser[securityId],
      reason: body?.reason,
    });

    return {
      message: 'Approval reverted. The request is pending again and can be approved or rejected afresh.',
      request,
      // Things the revert could not undo (process steps already run, refunds
      // already paid out). Surface these to the user — do not swallow them.
      notes,
    };
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

    const enriched = await Promise.all(requests.map(r => this.enrichRequest(r)));
    return {requests: enriched};
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
