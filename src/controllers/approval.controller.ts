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
import {
  CustomerRepository,
  GarmentRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  RefundDueRepository,
} from '../repositories';
import {ApprovalService} from '../services/approval.service';
import {StoreScopeService} from '../services/store-scope.service';

export class ApprovalController {
  constructor(
    @inject('services.approval') private approvalService: ApprovalService,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(RefundDueRepository) private refundDueRepo: RefundDueRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Store Scoping ────────────────────────────────────────────────────────

  /**
   * Resolve the order an approval hangs off. Every entityType reaches an order:
   * `order` directly, `garment` via its order item, `payment` via the transaction.
   * Returns null when the chain can't be resolved — treated as out of scope.
   */
  private async _resolveOrderId(req: ApprovalRequest): Promise<string | null> {
    if (req.entityType === 'order') return req.entityId ?? null;

    if (req.entityType === 'garment') {
      const garment = await this.garmentRepo.findOne({
        where: {id: req.entityId},
        fields: {id: true, orderItemId: true},
      });
      if (!garment?.orderItemId) return null;
      const orderItem = await this.orderItemRepo.findOne({
        where: {id: garment.orderItemId},
        fields: {id: true, orderId: true},
      });
      return orderItem?.orderId ?? null;
    }

    if (req.entityType === 'payment') {
      const payment = await this.paymentRepo.findOne({
        where: {id: req.entityId} as any,
        fields: {id: true, orderId: true} as any,
      });
      return (payment as {orderId?: string})?.orderId ?? null;
    }

    if (req.entityType === 'refund_due') {
      const refundDue = await this.refundDueRepo.findOne({
        where: {id: req.entityId},
        fields: {id: true, orderId: true},
      });
      return refundDue?.orderId ?? null;
    }

    return null;
  }

  /** Keep only approvals whose underlying order sits in the caller's stores. */
  private async _filterByStoreScope(
    requests: ApprovalRequest[],
    currentUser: UserProfile,
  ): Promise<ApprovalRequest[]> {
    const scope = await this.storeScopeService.resolve(currentUser);
    if (scope.global || !requests.length) return requests;

    const orderIds = await Promise.all(requests.map(r => this._resolveOrderId(r)));
    const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))] as string[];
    if (!uniqueOrderIds.length) return [];

    const orders = await this.orderRepo.find({
      where: {id: {inq: uniqueOrderIds}, isDeleted: false} as any,
      fields: {id: true, storeId: true} as any,
    });
    const allowedOrderIds = new Set(
      orders.filter(o => this.storeScopeService.allows(scope, o.storeId)).map(o => String(o.id)),
    );
    // Also allow orders reachable via an active inter-store transfer grant
    // to this scope — additive, doesn't narrow anything the direct
    // storeId check already allowed.
    for (const id of await this.storeScopeService.transferGrantedOrderIds(scope.storeIds)) {
      allowedOrderIds.add(String(id));
    }

    return requests.filter((_, index) => {
      const orderId = orderIds[index];
      return Boolean(orderId && allowedOrderIds.has(String(orderId)));
    });
  }

  private async enrichRequest(req: ApprovalRequest): Promise<object> {
    // mediaIds alone are useless to a client — always expand them to real
    // URLs, even for non-garment requests (payments carry cheque photos).
    const media = await this.approvalService.resolveMedia(req.mediaIds);

    // Cheque/PDC payments are also order-scoped, but carry no garments — a
    // flat row (amount, mode, reference) is all the Finance Approvals screen
    // needs, so this short-circuits before the REPROCESS-shaped branch below,
    // which expects metadata.garmentIds.
    if (
      req.entityType === 'order' &&
      (req.type === ApprovalRequestType.CHEQUE_PAYMENT || req.type === ApprovalRequestType.PDC_PAYMENT)
    ) {
      const order = await this.orderRepo.findOne({where: {id: req.entityId}});
      const customer = order?.customerId
        ? await this.customerRepo.findOne({where: {id: order.customerId}})
        : null;
      const meta = (req.metadata ?? {}) as {
        amount?: number;
        paymentMode?: string;
        transactionReference?: string;
      };
      return {
        ...req,
        orderId: req.entityId,
        orderNumber: order?.orderNumber ?? null,
        orderStatus: order?.status ?? null,
        customerId: order?.customerId ?? null,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : null,
        amount: meta.amount ?? null,
        paymentMode: meta.paymentMode ?? null,
        transactionReference: meta.transactionReference ?? null,
        media,
      };
    }

    // Order-scoped requests (post-delivery reprocess) name the order directly
    // and carry their garments in metadata — without this they would show as a
    // bare uuid with no order number and no items.
    if (req.entityType === 'order') {
      const order = await this.orderRepo.findOne({where: {id: req.entityId}});
      const metadata = (req.metadata ?? {}) as Record<string, unknown>;
      const garmentIds = Array.isArray(metadata.garmentIds)
        ? (metadata.garmentIds as string[])
        : [];

      const garments = garmentIds.length
        ? await this.garmentRepo.find({where: {id: {inq: garmentIds}} as any})
        : [];

      const orderItemIds = [...new Set(garments.map(g => g.orderItemId).filter(Boolean))];
      const orderItems = orderItemIds.length
        ? await this.orderItemRepo.find({where: {id: {inq: orderItemIds}} as any})
        : [];
      const itemIds = [...new Set(orderItems.map(oi => oi.itemId).filter(Boolean))];
      const items = itemIds.length
        ? await this.itemRepo.find({where: {id: {inq: itemIds}} as any})
        : [];

      const itemNameById = new Map(items.map(i => [i.id, i.name]));
      const itemNameByOrderItem = new Map(
        orderItems.map(oi => [oi.id, itemNameById.get(oi.itemId) ?? null]),
      );

      return {
        ...req,
        orderId: req.entityId,
        orderNumber: (order as any)?.orderNumber ?? null,
        orderStatus: order?.status ?? null,
        // One row per piece, so the approver can see exactly what is being redone.
        garments: garments.map(g => ({
          id: g.id,
          garmentTag: g.garmentTagNumber,
          status: g.status,
          itemName: itemNameByOrderItem.get(g.orderItemId) ?? null,
        })),
        garmentTag: garments.map(g => g.garmentTagNumber).filter(Boolean).join(', ') || null,
        // The list renders a single garmentStatus per row. These pieces are all
        // delivered in practice, but join the distinct values rather than pick
        // one, so a mixed set is never misreported as uniform.
        garmentStatus:
          [...new Set(garments.map(g => g.status).filter(Boolean))].join(', ') || null,
        itemName:
          [...new Set(garments.map(g => itemNameByOrderItem.get(g.orderItemId)).filter(Boolean))].join(
            ', ',
          ) || null,
        reprocessReason: metadata.reason ?? null,
        requestSource: metadata.source ?? null,
        // Distinct from requestSource above (who raised it: customer vs
        // store) — this is how the customer got in touch, and whether the
        // garment is at the store yet. See reprocess.service.ts's
        // ReprocessContactChannel.
        contactChannel: metadata.contactChannel ?? null,
        reworkOrderId: metadata.reworkOrderId ?? null,
        reworkOrderNumber: metadata.reworkOrderNumber ?? null,
        media,
      };
    }

    // Refund payouts hang off a RefundDue, not a garment or the order
    // directly — a flat row (amount, method, source, order/customer) is all
    // the Refund Payouts tab needs.
    if (req.entityType === 'refund_due') {
      const refundDue = await this.refundDueRepo.findOne({where: {id: req.entityId}});
      const order = refundDue?.orderId
        ? await this.orderRepo.findOne({where: {id: refundDue.orderId}})
        : null;
      const customer = refundDue?.customerId
        ? await this.customerRepo.findOne({where: {id: refundDue.customerId}})
        : null;
      const meta = (req.metadata ?? {}) as {
        method?: string;
        bankDetails?: Record<string, unknown>;
      };
      return {
        ...req,
        refundDueId: refundDue?.id ?? null,
        orderId: refundDue?.orderId ?? null,
        orderNumber: order?.orderNumber ?? null,
        customerId: refundDue?.customerId ?? null,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : null,
        amount: refundDue?.amount ?? null,
        reason: refundDue?.reason ?? null,
        sourceLabel: refundDue?.sourceLabel ?? null,
        method: refundDue?.method ?? meta.method ?? null,
        bankDetails: refundDue?.bankDetails ?? meta.bankDetails ?? null,
        refundDueStatus: refundDue?.status ?? null,
        media,
      };
    }

    if (req.entityType !== 'garment') return {...req, media};

    const garment = await this.garmentRepo.findOne({where: {id: req.entityId}});
    if (!garment) return {...req, media};

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
      media,
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
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('status') status?: ApprovalRequestStatus,
    @param.query.string('type') type?: string,
    @param.query.string('entityType') entityType?: string,
    @param.query.string('entityId') entityId?: string,
    @param.query.string('assignedToRole') assignedToRole?: string,
  ): Promise<object> {
    const where: Where<ApprovalRequest> = {};
    if (status) (where as Record<string, unknown>).status = status;
    if (type) {
      // Comma-separated so the Finance Approvals screen can fetch both
      // cheque_payment and pdc_payment in one call instead of two.
      const types = type.split(',').map(t => t.trim()).filter(Boolean);
      (where as Record<string, unknown>).type = types.length > 1 ? {inq: types} : types[0];
    }
    if (entityType) (where as Record<string, unknown>).entityType = entityType;
    if (entityId) (where as Record<string, unknown>).entityId = entityId;
    if (assignedToRole) (where as Record<string, unknown>).assignedToRole = assignedToRole;

    const requests = await this.approvalRequestRepo.find({
      where,
      order: ['createdAt DESC'],
    });

    const inScope = await this._filterByStoreScope(requests, currentUser);
    const enriched = await Promise.all(inScope.map(r => this.enrichRequest(r)));
    return {requests: enriched};
  }

  // ─── Get Single Request + Audit Trail ────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['approval:read']})
  @get('/approval-requests/{id}')
  @response(200, {description: 'Approval request detail with audit trail'})
  async getById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    const request = await this.approvalRequestRepo.findOne({where: {id}});
    if (!request) throw new HttpErrors.NotFound('Approval request not found.');

    const [inScope] = await this._filterByStoreScope([request], currentUser!);
    if (!inScope) throw new HttpErrors.NotFound('Approval request not found.');

    const [enriched, auditLog] = await Promise.all([
      this.enrichRequest(request),
      this.approvalAuditLogRepo.find({
        where: {approvalRequestId: id},
        order: ['performedAt ASC'],
      }),
    ]);

    return {request: enriched, auditLog};
  }
}
