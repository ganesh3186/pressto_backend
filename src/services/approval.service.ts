import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ApprovalActionRepository} from '../repositories/approval-action.repository';
import {ApprovalAuditLogRepository} from '../repositories/approval-audit-log.repository';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {GarmentRepository} from '../repositories/garment.repository';
import {GarmentStatusHistoryRepository} from '../repositories/garment-status-history.repository';
import {GarmentProcessLogRepository} from '../repositories/garment-process-log.repository';
import {ChallanRepository} from '../repositories/challan.repository';
import {InvoiceRepository} from '../repositories/invoice.repository';
import {ItemRepository} from '../repositories/item.repository';
import {MediaRepository} from '../repositories/media.repository';
import {OrderItemRepository} from '../repositories/order-item.repository';
import {OrderRepository} from '../repositories/order.repository';
import {PaymentTransactionRepository} from '../repositories/payment-transaction.repository';
import {ServiceRepository} from '../repositories/service.repository';
import {WalletRepository} from '../repositories/wallet.repository';
import {WalletTransactionRepository} from '../repositories/wallet-transaction.repository';
import {ApprovalActionType, CUSTOMER_UPGRADE_ACTIONS} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {ProcessLogStatus} from '../models/process-log-status.enum';
import {WalletTransactionType} from '../models/wallet-transaction-type.enum';
import {ReferenceType} from '../models/reference-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {APPROVAL_ROLE_ROUTING, ApprovalRequest} from '../models/approval-request.model';
import {AuditService} from './audit.service';
import {OrderService} from './order.service';

// What status to set on the garment immediately when a request is CREATED
const GARMENT_STATUS_ON_CREATE: Partial<Record<ApprovalRequestType, GarmentStatus>> = {
  // Upgrade: put on hold right away so no further processing happens until customer approves
  [ApprovalRequestType.UPGRADE_SERVICE]: GarmentStatus.ON_HOLD,
};

// What status to set on the garment when request is APPROVED
const GARMENT_STATUS_ON_APPROVE: Partial<Record<ApprovalRequestType, GarmentStatus>> = {
  // Return: go directly to returned_to_customer — no on_hold stop
  [ApprovalRequestType.RETURN_ITEM]: GarmentStatus.RETURNED_TO_CUSTOMER,
  // Upgrade: on approve, move to in_inspection so the new service process can be initialised
  [ApprovalRequestType.UPGRADE_SERVICE]: GarmentStatus.IN_INSPECTION,
};

/**
 * Coerce a money column to a usable number, rounded to 2dp.
 *
 * Postgres `numeric` columns come back from the driver as STRINGS, even though
 * the LoopBack model types them as `number` — so the compiler cannot catch this.
 * `"1200" + 280` silently yields `"1200280"`, while `"1200" - 280` coerces and
 * works. That asymmetry means addition bugs hide behind subtractions that look
 * fine. Run every money value read from the DB through here before doing maths
 * on it.
 */
function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Everything a resolve() can mutate, captured before the effects run. Stored on
// approvalRequest.metadata._revertSnapshot and replayed by revert().
//
// Deliberately absent: garment_process_log rows and wallet balances. Reverting
// never rewinds work already done on the shop floor, and never claws money back
// out of a customer's wallet.
interface RevertSnapshot {
  garmentStatus?: string;
  orderItem?: {
    id: string;
    serviceId: string;
    quantity: number;
    basePrice?: number;
    unitPrice?: number;
    totalPrice?: number;
  };
  order?: {id: string; subtotal?: number; totalAmount?: number};
  invoice?: {id: string; subtotal?: number; totalAmount?: number; balanceDue?: number; items?: unknown[]};
  challan?: {id: string; subtotal?: number; totalAmount?: number; items?: unknown[]};
  refundedToWallet?: number;
}

@injectable({scope: BindingScope.TRANSIENT})
export class ApprovalService {
  constructor(
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalActionRepository) private approvalActionRepo: ApprovalActionRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @repository(GarmentProcessLogRepository) private processLogRepo: GarmentProcessLogRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(MediaRepository) private mediaRepo: MediaRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @inject('services.audit') private auditService: AuditService,
    @inject('services.order') private orderService: OrderService,
  ) {}

  async createRequest(params: {
    type: ApprovalRequestType;
    entityType: string;
    entityId: string;
    requestedBy: string;
    requestReason?: string;
    mediaIds?: string[];
    metadata?: Record<string, unknown>;
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
      mediaIds: params.mediaIds,
      metadata: params.metadata,
    });

    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: request.id,
      eventType: 'created',
      remarks: `Request created for ${params.type} on ${params.entityType} ${params.entityId}`,
      performedBy: params.requestedBy,
    });

    // Apply immediate status change when needed (e.g. upgrade puts garment on_hold right away)
    const immediateStatus = GARMENT_STATUS_ON_CREATE[params.type];
    if (immediateStatus && params.entityType === 'garment') {
      await this._updateGarmentStatus(params.entityId, immediateStatus, params.requestedBy,
        `Put on hold — ${params.type} approval requested`);
    }

    return request;
  }

  async resolve(params: {
    requestId: string;
    action: ApprovalActionType;
    performedBy: string;
    comments?: string;
    mediaIds?: string[];
    approvalSource?: string;
    onBehalfOfCustomerId?: string;
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

    // Photograph every row the effects below are about to touch, BEFORE they run.
    // This is what a later revert restores from — reconstructing it from audit_log
    // after the fact would be guesswork.
    const revertSnapshot = await this._captureSnapshot(request);

    await this.approvalActionRepo.create({
      id: v4(),
      approvalRequestId: params.requestId,
      action: params.action,
      performedBy: params.performedBy,
      comments: params.comments,
      mediaIds: params.mediaIds,
      approvalSource: params.approvalSource,
      onBehalfOfCustomerId: params.onBehalfOfCustomerId,
    });

    await this.approvalRequestRepo.updateById(params.requestId, {
      status: newStatus,
      resolvedAt: new Date(),
      updatedAt: new Date(),
      metadata: {...(request.metadata ?? {}), _revertSnapshot: revertSnapshot},
    });

    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: params.requestId,
      eventType: params.action,
      remarks: params.comments,
      performedBy: params.performedBy,
    });

    const resolved = await this.approvalRequestRepo.findById(params.requestId);

    await this.auditService.log({
      entityType: request.entityType,
      entityId: request.entityId,
      actionType: `approval_${params.action}`,
      performedBy: params.performedBy,
      before: {approvalStatus: ApprovalRequestStatus.PENDING},
      after: {
        approvalStatus: newStatus,
        approvalRequestId: params.requestId,
        approvalSource: params.approvalSource,
        onBehalfOfCustomerId: params.onBehalfOfCustomerId,
      },
      remarks: params.comments,
    });

    if (params.action === ApprovalActionType.APPROVED) {
      await this._applyApproveEffect(request, params.performedBy);
    } else {
      await this._applyRejectEffect(request, params.performedBy, params.action);
    }

    return resolved;
  }

  // ─── Downstream effects on APPROVE ───────────────────────────────────────

  private async _applyApproveEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    if (request.entityType !== 'garment') return;

    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    if (!garment) return;

    const newStatus = GARMENT_STATUS_ON_APPROVE[request.type];
    if (newStatus) {
      await this._updateGarmentStatus(request.entityId, newStatus, performedBy,
        `Auto-updated via ${request.type} approval`);
    }

    // Upgrade approved: swap serviceId on the orderItem and recalculate price
    if (request.type === ApprovalRequestType.UPGRADE_SERVICE) {
      await this._applyUpgradeOnOrderItem(garment.orderItemId, request, performedBy);
    }

    // Item damaged approved: log it (no status change — garment stays on_hold until manually resolved)

    // Reprocess approved: reset the process logs and send the garment back into
    // processing so the workshop redoes every step. The garment_status_history
    // entry written below is the trail the client sees for the reprocess.
    if (request.type === ApprovalRequestType.REPROCESS) {
      await this._applyReprocess(request, performedBy);
    }

    // Return approved: remove the returned garment from billing, reflect on
    // invoice + challan, and refund any already-paid amount to the wallet.
    if (request.type === ApprovalRequestType.RETURN_ITEM) {
      await this._applyReturnEffect(request, performedBy);
    }
  }

  // ─── Return: reduce billing for the returned garment + refund to wallet ─────

  private async _applyReturnEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    if (!garment) return;
    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) return;
    const order = await this.orderRepo.findOne({where: {id: orderItem.orderId, isDeleted: false}});
    if (!order) return;

    // The order total is intentionally LEFT UNCHANGED — the order stays the
    // record of what was ordered. A return is handled as money going back to the
    // customer, not by shrinking the bill. We only change the garment status
    // (done via GARMENT_STATUS_ON_APPROVE) and record a refund.

    // Full value the customer paid for this one piece = unit price + its share of
    // the order's tax.
    const unitPrice = money(orderItem.unitPrice);
    if (unitPrice <= 0) return;
    const orderSubtotal = money(order.subtotal);
    const share = orderSubtotal > 0 ? unitPrice / orderSubtotal : 0;
    const taxShare = money(money(order.taxAmount) * share);
    const pieceValue = money(unitPrice + taxShare);

    // How much THIS order actually collected — split-aware, so the refund is
    // scoped to this order alone. A split child keeps its money in
    // allocatedPayment (no transaction rows); a split parent's transactions were
    // superseded by its allocated share. Refund entries are excluded. Returning
    // from a child therefore refunds from the child, never the parent.
    const payments = await this.paymentRepo.find({where: {orderId: order.id}} as any);
    const txnCollected = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? 0 : money(p.amount)),
      0,
    );
    const alreadyRefunded = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? money(p.amount) : 0),
      0,
    );
    const allocPay = money((order as any).allocatedPayment);
    const isChild = !!(order as any).parentOrderId;
    const collected = isChild
      ? money(allocPay + txnCollected)
      : allocPay > 0
        ? allocPay
        : txnCollected;

    // Never refund more than the customer still has un-refunded on this order.
    const refundable = money(collected - alreadyRefunded);
    const refundAmount = money(Math.min(pieceValue, Math.max(0, refundable)));

    if (refundAmount > 0) {
      // Money back to the customer's wallet.
      await this._creditWallet(
        order.customerId!,
        refundAmount,
        `Return refund — garment ${garment.garmentTagNumber} (order ${order.orderNumber})`,
        order.id,
      );
      // A visible refund entry in the order's payment history (money out). It is
      // NOT counted toward amount-collected, so the order total/balance are
      // unaffected — it just records that we returned the money.
      const {v4} = await import('uuid');
      await this.paymentRepo.create({
        id: v4(),
        orderId: order.id,
        paymentMode: PaymentMode.WALLET,
        transactionType: 'refund',
        amount: refundAmount,
        paymentDate: new Date(),
      } as any);

      await this._mergeIntoSnapshot(request.id, {refundedToWallet: refundAmount});
    }

    await this.auditService.log({
      entityType: 'order_item',
      entityId: orderItem.id,
      actionType: 'item_returned',
      performedBy,
      before: {garmentStatus: 'active'},
      after: {garmentStatus: 'returned_to_customer', refundedToWallet: refundAmount},
      remarks: `Garment ${garment.garmentTagNumber} returned via approval ${request.id}${refundAmount > 0 ? ` — ₹${refundAmount} refunded to wallet` : ''}`,
    });
  }

  // Credit an amount to the customer's wallet + log a wallet transaction (credit note trail).
  private async _creditWallet(
    customerId: string,
    amount: number,
    remarks: string,
    orderId?: string,
  ): Promise<void> {
    const {v4} = await import('uuid');
    let wallet = await this.walletRepo.findOne({where: {customerId}});
    if (!wallet) {
      wallet = await this.walletRepo.create({id: v4(), customerId, currentBalance: 0});
    }
    const newBalance = parseFloat(((Number(wallet.currentBalance) || 0) + amount).toFixed(2));
    await this.walletRepo.updateById(wallet.id, {currentBalance: newBalance, updatedAt: new Date()});

    await this.walletTransactionRepo.create({
      id: v4(),
      walletId: wallet.id,
      transactionType: WalletTransactionType.CREDIT,
      amount,
      referenceType: ReferenceType.REFUND,
      referenceId: orderId,
      remarks,
      transactionDate: new Date(),
    });
  }

  // ─── Reprocess: reset process logs + return garment to in_process ──────────

  private async _applyReprocess(request: ApprovalRequest, performedBy: string): Promise<void> {
    const garmentId = request.entityId;

    // Reset every process-step log back to pending so the full process runs again.
    const logs = await this.processLogRepo.find({where: {garmentId} as any});
    for (const log of logs) {
      // eslint-disable-next-line no-await-in-loop
      await this.processLogRepo.updateById(log.id, {
        status: ProcessLogStatus.PENDING,
        startedAt: undefined,
        startedBy: undefined,
        completedAt: undefined,
        completedBy: undefined,
        qrScanned: false,
      } as any);
    }

    const reasonSuffix = request.requestReason ? ` — reason: ${request.requestReason}` : '';
    await this._updateGarmentStatus(
      garmentId,
      GarmentStatus.IN_PROCESS,
      performedBy,
      `Reprocess approved (request ${request.id}) — garment sent back for reprocessing${reasonSuffix}`,
    );
  }

  // ─── Downstream effects on REJECT ────────────────────────────────────────

  private async _applyRejectEffect(
    request: ApprovalRequest,
    performedBy: string,
    action: ApprovalActionType,
  ): Promise<void> {
    if (request.entityType !== 'garment') return;

    // Declined + return: the customer wants the piece back unprocessed. Same
    // downstream effect as an approved return_item — drop it from billing and
    // refund any overpayment.
    if (action === ApprovalActionType.REJECTED_AND_RETURN) {
      await this._updateGarmentStatus(
        request.entityId,
        GarmentStatus.RETURNED_TO_CUSTOMER,
        performedBy,
        `${request.type} declined — garment returned to customer`,
      );
      await this._applyReturnEffect(request, performedBy);
      return;
    }

    // Plain reject, or declined + carry on with the original service. Either way
    // the garment just comes off hold: orderItem.serviceId was never touched, so
    // processing resumes on the OLD service with no further action needed.
    if (request.type === ApprovalRequestType.UPGRADE_SERVICE) {
      const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
      if (garment?.status === GarmentStatus.ON_HOLD) {
        // Find the last non-on_hold status from history and restore it
        const history = await this.garmentStatusHistoryRepo.find({
          where: {garmentId: request.entityId},
          order: ['changedAt DESC'],
          limit: 10,
        });
        const prevEntry = history.find(h => h.status !== GarmentStatus.ON_HOLD);
        const restoreStatus = (prevEntry?.status as GarmentStatus) ?? GarmentStatus.IN_INSPECTION;
        const remarks =
          action === ApprovalActionType.REJECTED_AND_PROCESS
            ? `Upgrade declined — resuming ${restoreStatus} on the original service`
            : `Upgrade rejected — restored to ${restoreStatus}`;
        await this._updateGarmentStatus(request.entityId, restoreStatus, performedBy, remarks);
      }
    }
  }

  // ─── Upgrade: update orderItem service + price ────────────────────────────

  private async _applyUpgradeOnOrderItem(
    orderItemId: string,
    request: ApprovalRequest,
    performedBy: string,
  ): Promise<void> {
    const toServiceId = request.metadata?.toServiceId as string | undefined;
    if (!toServiceId) return;

    const orderItem = await this.orderItemRepo.findOne({where: {id: orderItemId}});
    if (!orderItem) return;

    const order = await this.orderRepo.findOne({where: {id: orderItem.orderId}});
    if (!order) return;

    // Reprice the new service through the SAME store→cluster→region→base waterfall,
    // then apply the order's delivery-tier uplift — identical to order creation.
    let pricing: {basePrice: number; resolvedPrice: number};
    try {
      pricing = await this.orderService.resolvePricing(order.storeId!, toServiceId, orderItem.itemId);
    } catch {
      // No price configured for the new service+item — fall back to existing base.
      const base = Number(orderItem.basePrice) || 0;
      pricing = {basePrice: base, resolvedPrice: base};
    }
    const deliveryMultiplier = 1 + (Number(order.deliveryTypePercentage) || 0) / 100;
    const newBasePrice = pricing.basePrice;
    const newUnitPrice = parseFloat((pricing.resolvedPrice * deliveryMultiplier).toFixed(2));
    const newTotalPrice = parseFloat((newUnitPrice * orderItem.quantity).toFixed(2));

    const oldTotalPrice = money(orderItem.totalPrice);
    const priceDiff = newTotalPrice - oldTotalPrice;

    await this.orderItemRepo.updateById(orderItemId, {
      serviceId: toServiceId,
      basePrice: newBasePrice,
      unitPrice: newUnitPrice,
      totalPrice: newTotalPrice,
      updatedAt: new Date(),
    });

    // Adjust order totals
    if (order && priceDiff !== 0) {
      await this.orderRepo.updateById(order.id, {
        subtotal: money(money(order.subtotal) + priceDiff),
        // Final total is a whole rupee; subtotal keeps decimals.
        totalAmount: Math.round(money(order.totalAmount) + priceDiff),
        updatedAt: new Date(),
      });

      const invoice = await this.invoiceRepo.findOne({where: {orderId: order.id}} as any);
      if (invoice) {
        await this.invoiceRepo.updateById(invoice.id, {
          subtotal: money(money(invoice.subtotal) + priceDiff),
          totalAmount: Math.round(money(invoice.totalAmount) + priceDiff),
          // An upgrade raises the bill, so the balance rises with it. Never let
          // it go negative if a downgrade ever produces a negative diff.
          balanceDue: Math.max(0, Math.round(money(invoice.balanceDue) + priceDiff)),
          updatedAt: new Date(),
        } as any);
      }

      const challan = await this.challanRepo.findOne({where: {orderId: order.id}} as any);
      if (challan) {
        const items = [...(challan.items ?? [])] as any[];
        const challanItemIdx = items.findIndex(i => i.orderItemId === orderItemId);
        if (challanItemIdx !== -1) {
          items[challanItemIdx] = {
            ...items[challanItemIdx],
            serviceId: toServiceId,
            unitPrice: newUnitPrice,
            totalPrice: newTotalPrice,
          };
        }

        await this.challanRepo.updateById(challan.id, {
          subtotal: money(money(challan.subtotal) + priceDiff),
          totalAmount: Math.round(money(challan.totalAmount) + priceDiff),
          items,
          updatedAt: new Date(),
        } as any);
      }
    }

    await this.auditService.log({
      entityType: 'order_item',
      entityId: orderItemId,
      actionType: 'service_upgrade',
      performedBy,
      before: {serviceId: orderItem.serviceId, unitPrice: orderItem.unitPrice, totalPrice: oldTotalPrice},
      after: {serviceId: toServiceId, unitPrice: newUnitPrice, totalPrice: newTotalPrice},
      remarks: `Service upgraded via approval ${request.id}`,
    });
  }

  // ─── Revert a resolved request back to pending ────────────────────────────
  // For rectifying a mistake: undoes the money and status changes the resolution
  // made, reopens the request, and puts the garment back on hold so it can be
  // approved or rejected afresh.
  //
  // What it does NOT undo, by design:
  //   • garment_process_log rows — work already done on the floor is kept
  //   • wallet credits — a refund already paid out is not clawed back
  // Both are reported back in `notes` so the caller can act on them.

  async revert(params: {
    requestId: string;
    performedBy: string;
    reason?: string;
  }): Promise<{request: ApprovalRequest; notes: string[]}> {
    const request = await this.approvalRequestRepo.findById(params.requestId);
    if (request.status === ApprovalRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest('This request is still pending — there is nothing to revert.');
    }

    const previousStatus = request.status;
    const snapshot = request.metadata?._revertSnapshot as RevertSnapshot | undefined;
    const notes: string[] = [];

    if (snapshot) {
      await this._restoreSnapshot(snapshot);
    } else {
      // Resolved before revert support existed, so nothing was photographed.
      notes.push(
        'No pre-resolve snapshot was recorded for this request, so pricing and billing were left untouched. Check the order totals manually.',
      );
    }

    if (snapshot?.refundedToWallet) {
      notes.push(
        `₹${snapshot.refundedToWallet} was refunded to the customer's wallet on return and has NOT been clawed back. Reconcile manually.`,
      );
    }

    if (request.type === ApprovalRequestType.REPROCESS) {
      notes.push(
        'The reprocess approval had reset this garment\'s process steps to pending. Those steps are left as they are — reverting does not restore prior step progress.',
      );
    }

    // Reverting an APPROVED upgrade puts the old service back on the order item,
    // but any process steps already initialised were built from the UPGRADED
    // service's step list. We keep them (process is never deleted), so the two
    // can now disagree — say so plainly rather than let it pass silently.
    if (
      request.type === ApprovalRequestType.UPGRADE_SERVICE &&
      previousStatus === ApprovalRequestStatus.APPROVED &&
      request.entityType === 'garment'
    ) {
      const logCount = await this.processLogRepo.count({garmentId: request.entityId} as any);
      if (logCount.count > 0) {
        notes.push(
          `Processing had already been initialised on the upgraded service (${logCount.count} step(s)). Those steps are kept, but they no longer match the service now on the order item — review them before processing continues.`,
        );
      }
    }

    const {v4} = await import('uuid');

    // Reopen the request. The original ApprovalAction row is kept — the trail
    // should show what was decided and that it was later reverted.
    await this.approvalRequestRepo.updateById(params.requestId, {
      status: ApprovalRequestStatus.PENDING,
      resolvedAt: null as unknown as Date,
      updatedAt: new Date(),
    });

    // Back on hold, exactly as it sat before anyone decided.
    if (request.entityType === 'garment') {
      await this._updateGarmentStatus(
        request.entityId,
        GarmentStatus.ON_HOLD,
        params.performedBy,
        `${previousStatus} decision reverted — awaiting a fresh decision`,
      );
    }

    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: params.requestId,
      eventType: 'reverted',
      remarks: params.reason ?? `Reverted from ${previousStatus} back to pending`,
      performedBy: params.performedBy,
    });

    await this.auditService.log({
      entityType: request.entityType,
      entityId: request.entityId,
      actionType: 'approval_reverted',
      performedBy: params.performedBy,
      before: {approvalStatus: previousStatus},
      after: {approvalStatus: ApprovalRequestStatus.PENDING, approvalRequestId: params.requestId},
      remarks: [params.reason, ...notes].filter(Boolean).join(' | '),
    });

    return {request: await this.approvalRequestRepo.findById(params.requestId), notes};
  }

  /** Photograph every row resolve()'s effects can mutate. */
  private async _captureSnapshot(request: ApprovalRequest): Promise<RevertSnapshot> {
    const snapshot: RevertSnapshot = {};
    if (request.entityType !== 'garment') return snapshot;

    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    if (!garment) return snapshot;
    snapshot.garmentStatus = garment.status;

    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) return snapshot;
    snapshot.orderItem = {
      id: orderItem.id,
      serviceId: orderItem.serviceId,
      quantity: orderItem.quantity,
      basePrice: orderItem.basePrice,
      unitPrice: orderItem.unitPrice,
      totalPrice: orderItem.totalPrice,
    };

    const order = await this.orderRepo.findOne({where: {id: orderItem.orderId, isDeleted: false}});
    if (!order) return snapshot;
    snapshot.order = {id: order.id, subtotal: order.subtotal, totalAmount: order.totalAmount};

    const [invoice, challan] = await Promise.all([
      this.invoiceRepo.findOne({where: {orderId: order.id}} as any),
      this.challanRepo.findOne({where: {orderId: order.id}} as any),
    ]);

    if (invoice) {
      snapshot.invoice = {
        id: invoice.id,
        subtotal: invoice.subtotal,
        totalAmount: invoice.totalAmount,
        balanceDue: invoice.balanceDue,
        items: invoice.items as unknown[],
      };
    }
    if (challan) {
      snapshot.challan = {
        id: challan.id,
        subtotal: challan.subtotal,
        totalAmount: challan.totalAmount,
        items: challan.items as unknown[],
      };
    }

    return snapshot;
  }

  /** Put every photographed row back the way it was. */
  private async _restoreSnapshot(snapshot: RevertSnapshot): Promise<void> {
    const now = new Date();

    if (snapshot.orderItem) {
      const {id, ...fields} = snapshot.orderItem;
      await this.orderItemRepo.updateById(id, {...fields, updatedAt: now});
    }
    if (snapshot.order) {
      const {id, ...fields} = snapshot.order;
      await this.orderRepo.updateById(id, {...fields, updatedAt: now});
    }
    if (snapshot.invoice) {
      const {id, ...fields} = snapshot.invoice;
      await this.invoiceRepo.updateById(id, {...fields, updatedAt: now} as any);
    }
    if (snapshot.challan) {
      const {id, ...fields} = snapshot.challan;
      await this.challanRepo.updateById(id, {...fields, updatedAt: now} as any);
    }
  }

  /** Fold extra facts into the snapshot after the effects have run. */
  private async _mergeIntoSnapshot(requestId: string, patch: Partial<RevertSnapshot>): Promise<void> {
    const request = await this.approvalRequestRepo.findById(requestId);
    const metadata = request.metadata ?? {};
    const snapshot = (metadata._revertSnapshot ?? {}) as RevertSnapshot;
    await this.approvalRequestRepo.updateById(requestId, {
      metadata: {...metadata, _revertSnapshot: {...snapshot, ...patch}},
      updatedAt: new Date(),
    });
  }

  // ─── Customer-facing view of an upgrade request ───────────────────────────
  // Everything the customer needs to decide: the garment, the service they are
  // on now vs the one being proposed, what the change costs, and the photos the
  // store uploaded when raising the request.
  //
  // The price shown is computed through the SAME store→cluster→region→base
  // waterfall + delivery uplift that _applyUpgradeOnOrderItem will apply on
  // approve, so the quoted difference is what actually lands on the invoice.

  async getUpgradeView(request: ApprovalRequest): Promise<Record<string, unknown>> {
    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    const orderItem = garment
      ? await this.orderItemRepo.findOne({where: {id: garment.orderItemId}})
      : null;
    const order = orderItem
      ? await this.orderRepo.findOne({where: {id: orderItem.orderId, isDeleted: false}})
      : null;

    const fromServiceId = orderItem?.serviceId;
    const toServiceId = request.metadata?.toServiceId as string | undefined;

    const [fromService, toService, item, media, decision] = await Promise.all([
      fromServiceId ? this.serviceRepo.findOne({where: {id: fromServiceId}}) : Promise.resolve(null),
      toServiceId ? this.serviceRepo.findOne({where: {id: toServiceId}}) : Promise.resolve(null),
      orderItem?.itemId ? this.itemRepo.findOne({where: {id: orderItem.itemId}}) : Promise.resolve(null),
      this.resolveMedia(request.mediaIds),
      this.approvalActionRepo.findOne({
        where: {approvalRequestId: request.id},
        order: ['actionDate DESC'],
      }),
    ]);

    // Quote the proposed service.
    const quantity = Number(orderItem?.quantity) || 0;
    const currentUnitPrice = Number(orderItem?.unitPrice) || 0;
    const currentTotal = Number(orderItem?.totalPrice) || 0;

    let newUnitPrice = currentUnitPrice;
    if (order && orderItem && toServiceId) {
      try {
        const pricing = await this.orderService.resolvePricing(
          order.storeId!,
          toServiceId,
          orderItem.itemId,
        );
        const deliveryMultiplier = 1 + (Number(order.deliveryTypePercentage) || 0) / 100;
        newUnitPrice = parseFloat((pricing.resolvedPrice * deliveryMultiplier).toFixed(2));
      } catch {
        // No price configured for the new service + item — quote no extra charge,
        // matching the fallback the approve path takes.
        newUnitPrice = currentUnitPrice;
      }
    }
    const newTotal = parseFloat((newUnitPrice * quantity).toFixed(2));

    const isPending = request.status === ApprovalRequestStatus.PENDING;

    return {
      id: request.id,
      type: request.type,
      status: request.status,
      requestReason: request.requestReason ?? null,
      createdAt: request.createdAt ?? null,
      resolvedAt: request.resolvedAt ?? null,

      garment: {
        id: garment?.id ?? null,
        tagNumber: garment?.garmentTagNumber ?? null,
        status: garment?.status ?? null,
        itemName: item?.name ?? null,
      },

      currentService: fromService
        ? {id: fromService.id, name: fromService.name, unitPrice: currentUnitPrice}
        : null,
      requestedService: toService
        ? {id: toService.id, name: toService.name, unitPrice: newUnitPrice}
        : null,

      pricing: {
        quantity,
        currentTotal,
        newTotal,
        difference: parseFloat((newTotal - currentTotal).toFixed(2)),
      },

      media,

      // What the customer may do right now. Empty once the request is resolved.
      availableActions: isPending ? CUSTOMER_UPGRADE_ACTIONS : [],
      // Only meaningful while resolved. A reverted request is pending again, and
      // its superseded ApprovalAction row must not be shown as the live decision.
      decision:
        !isPending && decision
          ? {action: decision.action, comments: decision.comments ?? null, at: decision.actionDate ?? null}
          : null,
    };
  }

  /**
   * Expand media UUIDs into displayable rows (url + name + type).
   *
   * An approval only stores `mediaIds`, which are useless to a client on their
   * own — every consumer needs the URL. Public so the admin controller reuses it
   * rather than re-implementing the lookup.
   */
  async resolveMedia(mediaIds?: string[]): Promise<object[]> {
    if (!mediaIds?.length) return [];
    const rows = await this.mediaRepo.find({where: {id: {inq: mediaIds}} as any});

    // Preserve the order the ids were stored in — `find` returns them in
    // whatever order the DB feels like, which would shuffle the gallery.
    const byId = new Map(rows.map(m => [m.id, m]));
    return mediaIds
      .map(id => byId.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map(m => ({
        id: m.id,
        fileUrl: m.fileUrl,
        fileName: m.fileName,
        fileOriginalName: m.fileOriginalName,
        fileType: m.fileType,
      }));
  }

  // ─── Internal helper ──────────────────────────────────────────────────────

  private async _updateGarmentStatus(
    garmentId: string,
    status: GarmentStatus,
    changedBy: string,
    remarks: string,
  ): Promise<void> {
    const {v4} = await import('uuid');
    await this.garmentRepo.updateById(garmentId, {status});
    await this.garmentStatusHistoryRepo.create({
      id: v4(),
      garmentId,
      status,
      changedAt: new Date(),
      changedBy,
      remarks,
    });
  }
}
