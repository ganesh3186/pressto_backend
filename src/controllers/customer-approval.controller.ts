import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {Customer} from '../models';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequest, CUSTOMER_ACTIONS_BY_TYPE} from '../models/approval-request.model';
import {
  ApprovalRequestRepository,
  CustomerRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
} from '../repositories';
import {ReprocessReason} from '../models/reprocess-reason.enum';
import {ApprovalService} from '../services/approval.service';
import {ReprocessService} from '../services/reprocess.service';

// Request types a customer is allowed to see and act on. Everything else
// (item_damaged, reprocess, cheque_payment, …) is routed to internal roles and
// must never surface on the customer app.
const CUSTOMER_FACING_TYPES: ApprovalRequestType[] = [
  ApprovalRequestType.UPGRADE_SERVICE,
  ApprovalRequestType.PROCESS_AT_RISK,
];

// Every action any customer-facing type might offer, for the OpenAPI schema
// enum below — the real per-request enforcement is CUSTOMER_ACTIONS_BY_TYPE.
const ALL_CUSTOMER_ACTIONS: ApprovalActionType[] = [
  ...new Set(CUSTOMER_FACING_TYPES.flatMap(type => CUSTOMER_ACTIONS_BY_TYPE[type] ?? [])),
];

/**
 * Customer-facing approvals — currently two request types, each with its own
 * view builder in ApprovalService (getApprovalView dispatches to the right
 * one) and its own answer set (CUSTOMER_ACTIONS_BY_TYPE):
 *
 * `upgrade_service` — the store wants to switch the garment to a different
 * service. Three answers:
 *   • approved             → service is swapped, order/invoice repriced, garment resumes
 *   • rejected_and_return  → garment is returned unprocessed, billing reduced, overpayment refunded
 *   • rejected_and_process → garment resumes on the ORIGINAL service, nothing repriced
 *
 * `process_at_risk` — staff found the garment unsafe to process as ordered
 * AND no upgrade removes the risk either. Two answers (no "process on the
 * original service" option — that's the very thing flagged as risky):
 *   • approved             → garment resumes processing, customer accepted the risk
 *   • rejected_and_return  → garment is returned unprocessed, billing reduced, overpayment refunded
 *
 * Scope is taken from the JWT (securityId → users.id → customer.userId), never
 * from a client-supplied id.
 */
export class CustomerApprovalController {
  constructor(
    @inject('services.approval') private approvalService: ApprovalService,
    @inject('services.reprocess') private reprocessService: ReprocessService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Resolve the Customer row that owns the JWT's user. */
  private async resolveCustomer(currentUser: UserProfile): Promise<Customer> {
    const userId = currentUser[securityId];
    const customer = await this.customerRepo.findOne({where: {userId, isDeleted: false}});
    if (!customer) {
      throw new HttpErrors.NotFound('Customer profile not found for this user.');
    }
    return customer;
  }

  /** Every garment id under an order the customer owns. */
  private async ownedGarmentIds(orderId: string, customerId: string): Promise<string[]> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.customerId !== customerId) {
      throw new HttpErrors.Forbidden('You do not have access to this order.');
    }

    const items = await this.orderItemRepo.find({where: {orderId}});
    if (!items.length) return [];

    const garments = await this.garmentRepo.find({
      where: {orderItemId: {inq: items.map(i => i.id)}, isDeleted: false} as any,
    });
    return garments.map(g => g.id);
  }

  /**
   * Hard-fail unless this approval hangs off a garment in an order the customer
   * owns. Walks approval → garment → orderItem → order.customerId.
   */
  private async assertOwnsApproval(request: ApprovalRequest, customerId: string): Promise<void> {
    if (request.entityType !== 'garment') {
      throw new HttpErrors.Forbidden('This approval is not actionable by a customer.');
    }
    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    const orderItem = garment
      ? await this.orderItemRepo.findOne({where: {id: garment.orderItemId}})
      : null;
    const order = orderItem
      ? await this.orderRepo.findOne({where: {id: orderItem.orderId, isDeleted: false}})
      : null;

    if (!order || order.customerId !== customerId) {
      throw new HttpErrors.Forbidden('You do not have access to this approval request.');
    }
  }

  // ─── List approvals for one order ──────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/approvals')
  @response(200, {
    description: 'Upgrade-service approvals raised against the garments in this order',
  })
  async myOrderApprovals(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @param.query.string('status') status?: ApprovalRequestStatus,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    const garmentIds = await this.ownedGarmentIds(orderId, customer.id);

    if (!garmentIds.length) {
      return {orderId, pendingCount: 0, approvals: []};
    }

    const where: Record<string, unknown> = {
      entityType: 'garment',
      entityId: {inq: garmentIds},
      type: {inq: CUSTOMER_FACING_TYPES},
    };
    if (status) where.status = status;

    const requests = await this.approvalRequestRepo.find({
      where: where as any,
      order: ['createdAt DESC'],
    });

    const approvals = await Promise.all(
      requests.map(r => this.approvalService.getApprovalView(r)),
    );

    return {
      orderId,
      pendingCount: approvals.filter(a => a.status === ApprovalRequestStatus.PENDING).length,
      approvals,
    };
  }

  // ─── Single approval detail ────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/approvals/{id}')
  @response(200, {description: 'One customer-facing approval in full detail'})
  async myApprovalDetail(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);

    const request = await this.approvalRequestRepo.findOne({where: {id}});
    if (!request) throw new HttpErrors.NotFound('Approval request not found.');
    if (!CUSTOMER_FACING_TYPES.includes(request.type)) {
      throw new HttpErrors.Forbidden('This approval is not actionable by a customer.');
    }
    await this.assertOwnsApproval(request, customer.id);

    return this.approvalService.getApprovalView(request);
  }

  // ─── Report a problem with a delivered order ───────────────────────────────
  // The customer's own way in. Same request and same approval queue as the
  // counter's — only the recorded source differs.

  @authenticate('jwt')
  @post('/profile/customer/orders/{orderId}/reprocess-request')
  @response(200, {description: 'Reprocess request raised, awaiting store approval'})
  async requestReprocess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {type: 'string', enum: Object.values(ReprocessReason)},
              remarks: {type: 'string', description: 'Required when reason is "other"'},
              mediaIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Photos of the problem',
              },
              garmentIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Items to redo. Omit to report the whole order.',
              },
            },
          },
        },
      },
    })
    body: {
      reason: ReprocessReason;
      remarks?: string;
      mediaIds?: string[];
      garmentIds?: string[];
    },
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    // Throws if the order is not theirs.
    await this.ownedGarmentIds(orderId, customer.id);

    return this.reprocessService.raiseRequest({
      orderId,
      garmentIds: body.garmentIds,
      reason: body.reason,
      remarks: body.remarks,
      mediaIds: body.mediaIds,
      requestedBy: currentUser[securityId],
      source: 'customer',
      // A customer raising this themselves is never standing in the store —
      // always defer the rework order until a pickup actually brings the
      // garment back, never the immediate in_store path.
      contactChannel: 'other',
    });
  }

  // ─── Track my reprocess requests ───────────────────────────────────────────
  // The approvals list above is upgrade-only and garment-scoped, so it would
  // never show these. Kept separate rather than widened, so responding to an
  // upgrade stays distinct from tracking a complaint.

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/reprocess-requests')
  @response(200, {description: 'Reprocess requests this customer raised on the order'})
  async myReprocessRequests(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    // Throws if the order is not theirs.
    await this.ownedGarmentIds(orderId, customer.id);

    const requests = await this.approvalRequestRepo.find({
      where: {
        type: ApprovalRequestType.REPROCESS,
        entityType: 'order',
        entityId: orderId,
      } as any,
      order: ['createdAt DESC'],
    });

    const media = await Promise.all(
      requests.map(r => this.approvalService.resolveMedia(r.mediaIds)),
    );

    return {
      orderId,
      pendingCount: requests.filter(r => r.status === ApprovalRequestStatus.PENDING).length,
      requests: requests.map((request, index) => {
        const metadata = (request.metadata ?? {}) as Record<string, unknown>;
        return {
          id: request.id,
          status: request.status,
          reason: metadata.reason ?? null,
          remarks: request.requestReason ?? null,
          garmentIds: Array.isArray(metadata.garmentIds) ? metadata.garmentIds : [],
          // Present once approved — the free rework order raised from this.
          reworkOrderId: metadata.reworkOrderId ?? null,
          reworkOrderNumber: metadata.reworkOrderNumber ?? null,
          media: media[index],
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
        };
      }),
    };
  }

  // ─── Respond: approve / reject+return / reject+process ─────────────────────

  @authenticate('jwt')
  @post('/profile/customer/approvals/{id}/respond')
  @response(200, {description: 'Approval answered'})
  async respond(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: {
                type: 'string',
                enum: ALL_CUSTOMER_ACTIONS,
                description:
                  'Which actions are valid depends on the request type — see ' +
                  'GET .../approvals/{id}\'s availableActions. For upgrade_service: ' +
                  'approved = do the upgrade; rejected_and_return = return the garment ' +
                  'unprocessed; rejected_and_process = process it on the original service. ' +
                  'For process_at_risk: approved = process it, accepting the risk; ' +
                  'rejected_and_return = return the garment unprocessed.',
              },
              comments: {type: 'string'},
            },
          },
        },
      },
    })
    body: {action: ApprovalActionType; comments?: string},
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);

    const request = await this.approvalRequestRepo.findOne({where: {id}});
    if (!request) throw new HttpErrors.NotFound('Approval request not found.');
    if (!CUSTOMER_FACING_TYPES.includes(request.type)) {
      throw new HttpErrors.Forbidden('This approval is not actionable by a customer.');
    }
    await this.assertOwnsApproval(request, customer.id);

    if (request.status !== ApprovalRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`This request has already been ${request.status}.`);
    }
    const allowedActions = CUSTOMER_ACTIONS_BY_TYPE[request.type] ?? [];
    if (!allowedActions.includes(body.action)) {
      throw new HttpErrors.BadRequest(
        `Invalid action. Choose one of: ${allowedActions.join(', ')}.`,
      );
    }

    await this.approvalService.resolve({
      requestId: id,
      action: body.action,
      performedBy: currentUser[securityId],
      comments: body.comments,
      // The customer answered it themselves — not recorded on their behalf, so
      // onBehalfOfCustomerId stays unset.
      approvalSource: 'direct',
    });

    const MESSAGES_BY_TYPE: Partial<Record<ApprovalRequestType, Partial<Record<ApprovalActionType, string>>>> = {
      [ApprovalRequestType.UPGRADE_SERVICE]: {
        [ApprovalActionType.APPROVED]:
          'Upgrade approved. Your garment will be processed with the new service.',
        [ApprovalActionType.REJECTED_AND_RETURN]:
          'Upgrade declined. Your garment will be returned to you and the charge removed from your bill.',
        [ApprovalActionType.REJECTED_AND_PROCESS]:
          'Upgrade declined. Your garment will be processed with the original service.',
      },
      [ApprovalRequestType.PROCESS_AT_RISK]: {
        [ApprovalActionType.APPROVED]:
          'Thanks — we\'ll go ahead and process your garment now.',
        [ApprovalActionType.REJECTED_AND_RETURN]:
          'Understood. Your garment will be returned to you unprocessed and the charge removed from your bill.',
      },
    };

    return {
      message: MESSAGES_BY_TYPE[request.type]?.[body.action] ?? 'Your response was recorded.',
      approval: await this.approvalService.getApprovalView(
        await this.approvalRequestRepo.findById(id),
      ),
    };
  }
}
