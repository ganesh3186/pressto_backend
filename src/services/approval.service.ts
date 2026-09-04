import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ApprovalActionRepository} from '../repositories/approval-action.repository';
import {ApprovalAuditLogRepository} from '../repositories/approval-audit-log.repository';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {GarmentRepository} from '../repositories/garment.repository';
import {GarmentStatusHistoryRepository} from '../repositories/garment-status-history.repository';
import {GarmentProcessLogRepository} from '../repositories/garment-process-log.repository';
import {GstTaxConfigurationRepository} from '../repositories/gst-tax-configuration.repository';
import {ChallanRepository} from '../repositories/challan.repository';
import {InvoiceRepository} from '../repositories/invoice.repository';
import {ItemRepository} from '../repositories/item.repository';
import {MediaRepository} from '../repositories/media.repository';
import {OrderItemRepository} from '../repositories/order-item.repository';
import {OrderRepository} from '../repositories/order.repository';
import {OrderStatusHistoryRepository} from '../repositories/order-status-history.repository';
import {PaymentTransactionRepository} from '../repositories/payment-transaction.repository';
import {ServiceRepository} from '../repositories/service.repository';
import {WalletRepository} from '../repositories/wallet.repository';
import {WalletTransactionRepository} from '../repositories/wallet-transaction.repository';
import {RefundDueRepository} from '../repositories/refund-due.repository';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {ORDER_STATUS_TRANSITIONS, OrderStatus} from '../models/order-status.enum';
import {ProcessLogStatus} from '../models/process-log-status.enum';
import {WalletTransactionType} from '../models/wallet-transaction-type.enum';
import {ReferenceType} from '../models/reference-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {RefundDue, RefundBankDetails} from '../models/refund-due.model';
import {RefundDueStatus} from '../models/refund-due-status.enum';
import {RefundReason} from '../models/refund-reason.enum';
import {RefundMethod} from '../models/refund-method.enum';
import {Order} from '../models/order.model';
import {
  APPROVAL_ROLE_ROUTING,
  ApprovalRequest,
  CUSTOMER_ACTIONS_BY_TYPE,
} from '../models/approval-request.model';
import {AuditService} from './audit.service';
import {OrderService} from './order.service';

// What status to set on the garment immediately when a request is CREATED.
// Every garment-level approval type is held the instant it's raised, so the
// waiting period never gets silently attributed to whatever pipeline stage
// (in_process, quality_check, ...) the garment happened to be sitting in —
// the piece is frozen there until someone decides.
const GARMENT_STATUS_ON_CREATE: Partial<Record<ApprovalRequestType, GarmentStatus>> = {
  [ApprovalRequestType.UPGRADE_SERVICE]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.RETURN_ITEM]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.ITEM_DAMAGED]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.REPROCESS]: GarmentStatus.ON_HOLD,
  [ApprovalRequestType.PROCESS_AT_RISK]: GarmentStatus.ON_HOLD,
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

// The final order/invoice/challan total is always a whole rupee — mirrors
// order.service.ts's roundRupee (not exported from there, so duplicated here
// rather than coupling the two services over a one-line utility).
function roundRupee(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
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
  order?: {id: string; subtotal?: number; totalAmount?: number; taxAmount?: number};
  invoice?: {id: string; subtotal?: number; totalAmount?: number; balanceDue?: number; items?: unknown[]};
  challan?: {id: string; subtotal?: number; totalAmount?: number; items?: unknown[]};
  refundedToWallet?: number;
  chequePaymentTransactionId?: string;
  // Set once a RefundDue is created for this request (Return Item /
  // Upgrade-downgrade overpayment) — replaces the old `refundedToWallet`
  // immediate-credit bookkeeping now that a payout is deferred behind its
  // own approval instead of executing here.
  refundDueId?: string;
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
    @repository(GstTaxConfigurationRepository) private gstConfigRepo: GstTaxConfigurationRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(MediaRepository) private mediaRepo: MediaRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderStatusHistoryRepository) private orderStatusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @repository(RefundDueRepository) private refundDueRepo: RefundDueRepository,
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

  // ─── Deferred refund payouts ──────────────────────────────────────────────
  // "Customer is owed money" is split into two separate, human-gated steps
  // per the client's requirement: nothing refunds automatically the instant
  // an overpayment is detected. createRefundDue() just records that ₹X is
  // owed and why (called from _applyReturnEffect, _applyUpgradeOnOrderItem,
  // and sales-return.controller.ts's approve()). Staff then pick a payout
  // method via selectPayoutMethod(), which raises a REFUND_PAYOUT approval —
  // only once THAT is approved does _applyRefundPayout() below actually move
  // the money.

  async createRefundDue(params: {
    orderId: string;
    customerId: string;
    amount: number;
    reason: RefundReason;
    sourceType: string;
    sourceId: string;
    sourceLabel?: string;
  }): Promise<RefundDue> {
    const {v4} = await import('uuid');
    return this.refundDueRepo.create({
      id: v4(),
      orderId: params.orderId,
      customerId: params.customerId,
      amount: params.amount,
      reason: params.reason,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceLabel: params.sourceLabel,
      status: RefundDueStatus.PENDING,
    });
  }

  async selectPayoutMethod(params: {
    refundDueId: string;
    method: RefundMethod;
    bankDetails?: RefundBankDetails;
    requestedBy: string;
  }): Promise<RefundDue> {
    const refundDue = await this.refundDueRepo.findById(params.refundDueId);
    if (refundDue.status !== RefundDueStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Refund is already ${refundDue.status}.`);
    }

    if (params.method === RefundMethod.BANK_ACCOUNT) {
      const b = params.bankDetails;
      if (!b?.accountHolderName || !b?.bankName || !b?.accountNumber || !b?.ifscCode) {
        throw new HttpErrors.BadRequest(
          'Bank account refunds need accountHolderName, bankName, accountNumber, and ifscCode.',
        );
      }
    }

    const request = await this.createRequest({
      type: ApprovalRequestType.REFUND_PAYOUT,
      entityType: 'refund_due',
      entityId: refundDue.id,
      requestedBy: params.requestedBy,
      metadata: {
        method: params.method,
        bankDetails: params.method === RefundMethod.BANK_ACCOUNT ? params.bankDetails : undefined,
        amount: refundDue.amount,
        orderId: refundDue.orderId,
        customerId: refundDue.customerId,
        reason: refundDue.reason,
        sourceLabel: refundDue.sourceLabel,
      },
    });

    await this.refundDueRepo.updateById(refundDue.id, {
      status: RefundDueStatus.REQUESTED,
      method: params.method,
      bankDetails: params.method === RefundMethod.BANK_ACCOUNT ? params.bankDetails : undefined,
      approvalRequestId: request.id,
      updatedAt: new Date(),
    });

    return this.refundDueRepo.findById(refundDue.id);
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
    // Post-delivery reprocess is raised against the ORDER, not a garment — the
    // pieces have left the building and their garments are terminal. Handled
    // before the garment guard below, which would otherwise drop it.
    if (
      request.type === ApprovalRequestType.REPROCESS &&
      request.entityType === 'order'
    ) {
      await this._applyPostDeliveryReprocess(request, performedBy);
      return;
    }

    // Cheque/PDC payments are raised against the ORDER (no garment involved,
    // and no PaymentTransaction exists yet — see order.service.ts's
    // pendingApprovalPayments). Handled before the garment guard below.
    if (
      request.entityType === 'order' &&
      (request.type === ApprovalRequestType.CHEQUE_PAYMENT || request.type === ApprovalRequestType.PDC_PAYMENT)
    ) {
      await this._applyChequePdcApproveEffect(request, performedBy);
      return;
    }

    // Refund payout approved: this is the moment the money actually moves —
    // raised against the RefundDue row, never a garment.
    if (request.entityType === 'refund_due' && request.type === ApprovalRequestType.REFUND_PAYOUT) {
      await this._applyRefundPayout(request, performedBy);
      return;
    }

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

    // Item damaged approved: no further status change — the garment stays
    // on_hold (set at request creation) until someone manually resolves it
    // via reprocess or return.

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

    // Risk approved: customer accepted the risk — no service/price change,
    // just resume processing from wherever it paused.
    if (request.type === ApprovalRequestType.PROCESS_AT_RISK) {
      await this._resumeGarmentFromHold(request.entityId, performedBy, 'Customer approved processing at risk');
    }
  }

  // ─── Cheque/PDC: turn the pending leg into a real payment ─────────────────
  // The amount was never collected at submission time (see
  // order.service.ts's pendingApprovalPayments) — approving is the moment it
  // actually becomes money in hand. Reused via the real addPayment() rather
  // than a duplicate PaymentTransaction construction, since addPayment()
  // already has the balance-due guard, the transaction wrapper, and wallet-
  // combination logic. A stale amount (e.g. balance shrank while pending,
  // such as a credit note landing first) throws a clean 400 from addPayment()
  // rather than silently short/over-paying — let it propagate.
  private async _applyChequePdcApproveEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    const meta = (request.metadata ?? {}) as {
      amount?: number;
      paymentMode?: PaymentMode;
      transactionReference?: string;
    };
    const result = (await this.orderService.addPayment(
      request.entityId,
      {
        paymentMode: meta.paymentMode as PaymentMode,
        amount: Number(meta.amount) || 0,
        transactionReference: meta.transactionReference,
      },
      0,
      performedBy,
      true, // this IS the moment the cheque/PDC leg becomes real, collected money
    )) as {payment?: {id: string}};

    await this._mergeIntoSnapshot(request.id, {chequePaymentTransactionId: result.payment?.id});

    await this.auditService.log({
      entityType: 'order',
      entityId: request.entityId,
      actionType: `${request.type}_approved`,
      performedBy,
      before: {},
      after: {amount: meta.amount, paymentMode: meta.paymentMode, transactionReference: meta.transactionReference},
      remarks: `${meta.paymentMode} payment of ₹${meta.amount} approved via approval ${request.id}`,
    });
  }

  // ─── Return: reduce billing for the returned garment + refund to wallet ─────

  private async _applyReturnEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    if (!garment) return;
    const orderItem = await this.orderItemRepo.findOne({where: {id: garment.orderItemId}});
    if (!orderItem) return;
    const order = await this.orderRepo.findOne({where: {id: orderItem.orderId, isDeleted: false}});
    if (!order) return;

    // If this was the last garment on the order still outstanding, the order
    // itself is done — nothing is left to deliver. Checked unconditionally,
    // ahead of the pricing/refund logic below, so a ₹0 garment (free rework,
    // fully discounted) still closes out the order correctly.
    await this._maybeMarkOrderReturned(order.id, garment.garmentTagNumber, request.id, performedBy);

    // Full value the customer is billed for this one piece = unit price
    // (× this garment's own area, for a measurement item billed per square
    // metre — same unitPrice × length × width rule order creation applies,
    // see order.service.ts's perUnitTotalPrices) plus its share of the
    // order's tax.
    const unitPrice = money(orderItem.unitPrice);
    if (unitPrice <= 0) return;
    const item = await this.itemRepo.findOne({where: {id: orderItem.itemId}});
    const area = Number(garment.length) * Number(garment.width);
    const pieceBasePrice =
      item?.isMeasurement && Number.isFinite(area) && area > 0 ? money(unitPrice * area) : unitPrice;
    if (pieceBasePrice <= 0) return;
    const orderSubtotal = money(order.subtotal);
    const share = orderSubtotal > 0 ? pieceBasePrice / orderSubtotal : 0;
    const taxShare = money(money(order.taxAmount) * share);
    const pieceValue = money(pieceBasePrice + taxShare);

    // The order/invoice/challan total drops by exactly what this piece was
    // billed for — a customer should never be left owing (or having paid) for
    // a garment they no longer have. Whether that surfaces as a smaller
    // balance due or an actual refund is derived below from what's already
    // been collected — never a manual choice, and never left unadjusted:
    //   prepaid (collected > new total)  → refund the difference
    //   unpaid/partial (collected ≤ new total) → balance due just shrinks
    const newOrderTotal = Math.max(0, roundRupee(money(order.totalAmount) - pieceValue));

    // How much THIS order actually collected vs. its new (reduced) total —
    // split-aware, so the refund is scoped to this order alone. A partially-
    // paid order that still owes more than it's paid after the reduction owes
    // nothing back; it just owes less.
    const {refundAmount, newBalanceDue} = await this._computeOverpaymentRefund(order, newOrderTotal);

    // Reduce the order itself — subtotal/tax component-wise (for anything that
    // reads them individually), totalAmount derived directly from the
    // already-rounded order.totalAmount rather than reconstructed from the
    // reduced components, so it can't drift from independent rounding.
    await this.orderRepo.updateById(order.id, {
      subtotal: money(orderSubtotal - unitPrice),
      taxAmount: money(money(order.taxAmount) - taxShare),
      totalAmount: newOrderTotal,
      updatedAt: new Date(),
    } as any);

    const invoice = await this.invoiceRepo.findOne({where: {orderId: order.id}} as any);
    if (invoice) {
      await this.invoiceRepo.updateById(invoice.id, {
        subtotal: money(money(invoice.subtotal) - unitPrice),
        totalAmount: newOrderTotal,
        balanceDue: newBalanceDue,
        updatedAt: new Date(),
      } as any);
    }

    const challan = await this.challanRepo.findOne({where: {orderId: order.id}} as any);
    if (challan) {
      await this.challanRepo.updateById(challan.id, {
        subtotal: money(money(challan.subtotal) - unitPrice),
        totalAmount: newOrderTotal,
        updatedAt: new Date(),
      } as any);
    }

    if (refundAmount > 0) {
      // No automatic refund — surface it as a RefundDue instead. Staff pick a
      // payout method (wallet / bank account / cash) from the order's invoice
      // dialogue; only once THAT gets its own approval does money move (see
      // selectPayoutMethod/_applyRefundPayout).
      const refundDue = await this.createRefundDue({
        orderId: order.id,
        customerId: order.customerId!,
        amount: refundAmount,
        reason: RefundReason.RETURN_ITEM,
        sourceType: 'garment',
        sourceId: garment.id,
        sourceLabel: `Garment ${garment.garmentTagNumber} returned`,
      });

      await this._mergeIntoSnapshot(request.id, {refundDueId: refundDue.id});
    }

    await this.auditService.log({
      entityType: 'order_item',
      entityId: orderItem.id,
      actionType: 'item_returned',
      performedBy,
      before: {garmentStatus: 'active', orderTotal: money(order.totalAmount)},
      after: {
        garmentStatus: 'returned_to_customer',
        orderTotal: newOrderTotal,
        balanceDue: newBalanceDue,
        refundDue: refundAmount,
      },
      remarks:
        `Garment ${garment.garmentTagNumber} returned via approval ${request.id} — ` +
        `order total reduced by ₹${pieceValue}` +
        (refundAmount > 0 ? ` — ₹${refundAmount} owed back to customer, refund pending` : ''),
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

  /**
   * How much of what's already been collected on this order exceeds its NEW
   * (already-reduced) total — the amount actually owed back to the customer.
   * Split-order aware: a split child's money lives in allocatedPayment, a
   * split parent's transactions were superseded by its allocated share, and
   * refund PaymentTransactions never count as collected. Also nets out any
   * RefundDue not yet paid out (pending or requested) — a payout being
   * "owed" but not yet executed still has to count as accounted for, or a
   * second return/downgrade on the same order before the first payout
   * happens would double-refund the same money. Shared by _applyReturnEffect
   * and the Upgrade/Downgrade overpayment check in _applyUpgradeOnOrderItem.
   */
  private async _computeOverpaymentRefund(
    order: Order,
    newOrderTotal: number,
  ): Promise<{refundAmount: number; newBalanceDue: number}> {
    const payments = await this.paymentRepo.find({where: {orderId: order.id}} as any);
    const txnCollected = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? 0 : money(p.amount)),
      0,
    );
    const paidRefunds = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? money(p.amount) : 0),
      0,
    );
    const unpaidRefundDues = await this.refundDueRepo.find({
      where: {orderId: order.id, status: {inq: [RefundDueStatus.PENDING, RefundDueStatus.REQUESTED]}},
    });
    const unpaidRefundTotal = unpaidRefundDues.reduce((s, r) => s + money(r.amount), 0);
    const alreadyAccountedFor = money(paidRefunds + unpaidRefundTotal);

    const allocPay = money((order as any).allocatedPayment);
    const isChild = !!(order as any).parentOrderId;
    const collected = isChild
      ? money(allocPay + txnCollected)
      : allocPay > 0
        ? allocPay
        : txnCollected;

    // Net of any earlier returns/downgrades on this same order, whether
    // already paid out or still awaiting their own payout approval.
    const netPaid = money(collected - alreadyAccountedFor);
    // Only the excess over the NEW (already-reduced) total is refundable —
    // not the full amount. A partially-paid order that still owes more than
    // it's paid after the reduction owes nothing back; it just owes less.
    const refundAmount = money(Math.max(0, netPaid - newOrderTotal));
    const newBalanceDue = money(Math.max(0, newOrderTotal - netPaid));
    return {refundAmount, newBalanceDue};
  }

  /**
   * Actually moves the money for a refund, by method. Shared by the
   * deferred RefundDue payout path below (_applyRefundPayout, gated behind
   * its own REFUND_PAYOUT approval — Return Item and Upgrade/Downgrade) and
   * Sales Return's approve(), which executes immediately using the method
   * chosen at credit-note creation time instead of going through a second
   * approval.
   */
  async executeRefundPayout(params: {
    customerId: string;
    orderId: string;
    amount: number;
    method: string;
    bankDetails?: RefundBankDetails;
    remarks: string;
  }): Promise<void> {
    const {v4} = await import('uuid');
    const amount = money(params.amount);

    if (params.method === RefundMethod.WALLET) {
      await this._creditWallet(params.customerId, amount, params.remarks, params.orderId);
      await this.paymentRepo.create({
        id: v4(),
        orderId: params.orderId,
        paymentMode: PaymentMode.WALLET,
        transactionType: 'refund',
        amount,
        paymentDate: new Date(),
      });
    } else if (params.method === RefundMethod.BANK_ACCOUNT) {
      await this.paymentRepo.create({
        id: v4(),
        orderId: params.orderId,
        paymentMode: PaymentMode.BANK_TRANSFER,
        transactionType: 'refund',
        amount,
        transactionReference: params.bankDetails
          ? `${params.bankDetails.bankName} •••${String(params.bankDetails.accountNumber).slice(-4)}`
          : undefined,
        gatewayResponse: params.bankDetails ? JSON.stringify(params.bankDetails) : undefined,
        paymentDate: new Date(),
      });
    } else {
      // 'cash' (or a missing method, which should never happen —
      // both callers always set one before this can run).
      await this.paymentRepo.create({
        id: v4(),
        orderId: params.orderId,
        paymentMode: PaymentMode.CASH,
        transactionType: 'refund',
        amount,
        paymentDate: new Date(),
      });
    }
  }

  /**
   * A REFUND_PAYOUT approval was granted — the moment the money actually
   * moves. Raised against a RefundDue row (never a garment), method + bank
   * details already chosen at selectPayoutMethod() time.
   */
  private async _applyRefundPayout(request: ApprovalRequest, performedBy: string): Promise<void> {
    const refundDue = await this.refundDueRepo.findOne({where: {id: request.entityId}});
    if (!refundDue || refundDue.status === RefundDueStatus.PAID) return;

    const method = refundDue.method as RefundMethod | undefined;
    const amount = money(refundDue.amount);

    await this.executeRefundPayout({
      customerId: refundDue.customerId,
      orderId: refundDue.orderId,
      amount,
      method: method ?? RefundMethod.CASH,
      bankDetails: refundDue.bankDetails,
      remarks: `Refund payout — ${refundDue.sourceLabel ?? refundDue.reason} (approval ${request.id})`,
    });

    await this.refundDueRepo.updateById(refundDue.id, {
      status: RefundDueStatus.PAID,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    });

    await this._mergeIntoSnapshot(request.id, {refundDueId: refundDue.id});

    await this.auditService.log({
      entityType: 'refund_due',
      entityId: refundDue.id,
      actionType: 'refund_paid_out',
      performedBy,
      before: {status: RefundDueStatus.REQUESTED},
      after: {status: RefundDueStatus.PAID, method, amount},
      remarks: `₹${amount} refunded via ${method} — approval ${request.id}`,
    });
  }

  // ─── Reprocess: reset process logs + return garment to in_process ──────────

  /**
   * Post-delivery reprocess approved: raise the free rework order.
   *
   * The original order and its garments are left exactly as they are — they are
   * the record of the first pass, and a delivered garment has no legal next
   * status. The rework runs on new garments with new tags.
   */
  private async _applyPostDeliveryReprocess(
    request: ApprovalRequest,
    performedBy: string,
  ): Promise<void> {
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const garmentIds = Array.isArray(metadata.garmentIds)
      ? (metadata.garmentIds as string[])
      : [];

    if (!garmentIds.length) {
      throw new HttpErrors.BadRequest(
        'This reprocess request does not name any garments, so no rework order can be raised.',
      );
    }

    const result = await this.orderService.createReworkOrder({
      originalOrderId: request.entityId,
      garmentIds,
      createdBy: performedBy,
      reason: typeof metadata.reason === 'string' ? metadata.reason : undefined,
      remarks: request.requestReason,
    });

    // Recorded on the request so staff can jump straight to the rework order.
    await this.approvalRequestRepo.updateById(request.id, {
      metadata: {
        ...metadata,
        reworkOrderId: result.order.id,
        reworkOrderNumber: result.order.orderNumber,
      },
    });

    const {v4} = await import('uuid');
    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: request.id,
      eventType: 'reprocess_order_created',
      remarks:
        `Free rework order ${result.order.orderNumber} created with ` +
        `${result.garmentsCreated} garment(s).`,
      performedBy,
    });
  }

  private async _applyReprocess(request: ApprovalRequest, performedBy: string): Promise<void> {
    await this._resetProcessLogsAndReprocess(request.entityId, performedBy, request.requestReason, request.id);
  }

  /**
   * Send a garment back into processing without raising an approval request
   * at all. For a garment that hasn't left the store yet, a reprocess is a
   * normal workflow correction, not a decision that needs a store exec's
   * sign-off — that gating is reserved for the genuinely consequential case,
   * a garment already dispatched or delivered (see
   * GarmentActionsController.requestReprocess for the status check, and
   * _applyPostDeliveryReprocess for the separate, still approval-gated,
   * order-level after-delivery flow).
   */
  async applyReprocessDirectly(garmentId: string, performedBy: string, reason?: string): Promise<void> {
    await this._resetProcessLogsAndReprocess(garmentId, performedBy, reason, undefined);
  }

  private async _resetProcessLogsAndReprocess(
    garmentId: string,
    performedBy: string,
    reason: string | undefined,
    requestId: string | undefined,
  ): Promise<void> {
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

    const reasonSuffix = reason ? ` — reason: ${reason}` : '';
    const remarks = requestId
      ? `Reprocess approved (request ${requestId}) — garment sent back for reprocessing${reasonSuffix}`
      : `Reprocess requested — garment sent back for reprocessing (still in-store, no approval needed)${reasonSuffix}`;
    await this._updateGarmentStatus(garmentId, GarmentStatus.IN_PROCESS, performedBy, remarks);
  }

  // ─── Downstream effects on REJECT ────────────────────────────────────────

  private async _applyRejectEffect(
    request: ApprovalRequest,
    performedBy: string,
    action: ApprovalActionType,
  ): Promise<void> {
    // Cheque/PDC rejected: nothing was ever collected (no PaymentTransaction
    // exists — see order.service.ts's pendingApprovalPayments), so the
    // order's balance due already reflects the rejection with no further
    // action needed.
    if (
      request.entityType === 'order' &&
      (request.type === ApprovalRequestType.CHEQUE_PAYMENT || request.type === ApprovalRequestType.PDC_PAYMENT)
    ) {
      return;
    }

    // Refund payout rejected: nothing was ever paid out (the method choice
    // alone doesn't move money — see selectPayoutMethod/_applyRefundPayout),
    // so just reopen the RefundDue for staff to pick a different method.
    if (request.entityType === 'refund_due' && request.type === ApprovalRequestType.REFUND_PAYOUT) {
      await this.refundDueRepo.updateById(request.entityId, {
        status: RefundDueStatus.PENDING,
        method: null,
        bankDetails: null,
        approvalRequestId: null,
        updatedAt: new Date(),
      } as unknown as Partial<RefundDue>);
      return;
    }

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

    // Plain reject, or declined + carry on as before. Either way, whatever the
    // request touched was never actually applied (upgrade's serviceId swap,
    // return's removal, reprocess's log reset all only happen on APPROVE), so
    // the garment just comes off hold and resumes wherever it left off — no
    // other field needs undoing. Applies to every type this service holds at
    // creation (see GARMENT_STATUS_ON_CREATE), not just upgrades.
    if (GARMENT_STATUS_ON_CREATE[request.type]) {
      const reason =
        action === ApprovalActionType.REJECTED_AND_PROCESS
          ? `${request.type} declined`
          : `${request.type} rejected`;
      await this._resumeGarmentFromHold(request.entityId, performedBy, reason);
    }
  }

  /**
   * Move a garment off ON_HOLD back to wherever it was before — walks
   * garment_status_history newest-first for the last real pipeline stage,
   * skipping ON_HOLD and RETURNED_TO_CUSTOMER (a leftover
   * RETURNED_TO_CUSTOMER entry from an earlier approve-then-revert can never
   * legitimately be "the real prior stage" — see the reject-effect fix
   * above). Shared by the generic reject path (nothing the request touched
   * was ever applied, so it just resumes) and process_at_risk's approve path
   * (customer accepted the risk, so processing just continues from where it
   * paused — no service/price change, unlike an upgrade approval).
   */
  private async _resumeGarmentFromHold(
    garmentId: string,
    performedBy: string,
    reason: string,
  ): Promise<void> {
    const garment = await this.garmentRepo.findOne({where: {id: garmentId, isDeleted: false}});
    if (garment?.status !== GarmentStatus.ON_HOLD) return;

    const history = await this.garmentStatusHistoryRepo.find({
      where: {garmentId},
      order: ['changedAt DESC'],
      limit: 10,
    });
    const prevEntry = history.find(
      h => h.status !== GarmentStatus.ON_HOLD && h.status !== GarmentStatus.RETURNED_TO_CUSTOMER,
    );
    const restoreStatus = (prevEntry?.status as GarmentStatus) ?? GarmentStatus.IN_INSPECTION;
    await this._updateGarmentStatus(garmentId, restoreStatus, performedBy, `${reason} — resumed to ${restoreStatus}`);
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
    // A measurement item (curtain/carpet) is billed per square metre, and
    // its garments can each carry a different area — quantity × unit price
    // alone understates/overstates the real total unless every garment
    // happens to share the same area. Sum each garment's own area instead,
    // same rule order creation applies (order.service.ts's
    // perUnitTotalPrices) — a plain piece-priced item still reduces to
    // unitPrice × quantity, since totalArea has no meaning for it.
    const item = await this.itemRepo.findOne({where: {id: orderItem.itemId}});
    let newTotalPrice: number;
    if (item?.isMeasurement) {
      const garments = await this.garmentRepo.find({
        where: {orderItemId, isDeleted: false} as object,
      });
      const totalArea = garments.reduce(
        (sum, g) => sum + (Number(g.length) || 0) * (Number(g.width) || 0),
        0,
      );
      newTotalPrice = parseFloat((newUnitPrice * totalArea).toFixed(2));
    } else {
      newTotalPrice = parseFloat((newUnitPrice * orderItem.quantity).toFixed(2));
    }

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
      const oldOrderTotal = money(order.totalAmount);
      const newSubtotal = money(money(order.subtotal) + priceDiff);
      // Recompute tax fresh from the current GST config against the new
      // subtotal, rather than carrying the old (now stale) taxAmount
      // forward unchanged — an un-recomputed taxAmount silently corrupts
      // any later credit note's own "effective tax rate" derivation
      // (sales-return.controller.ts's create()), over- or under-crediting
      // the customer on a subsequent return.
      const gstConfig = await this.gstConfigRepo.findOne({where: {isActive: true, isDeleted: false}});
      const gstRate = gstConfig ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage) : 0;
      const taxableAmount = money(newSubtotal - money(order.discountAmount));
      const newTaxAmount = gstRate > 0 ? money((taxableAmount * gstRate) / 100) : 0;
      // Final total is a whole rupee; subtotal/tax keep decimals.
      const newOrderTotal = Math.max(0, Math.round(taxableAmount + newTaxAmount));
      const totalDiff = newOrderTotal - oldOrderTotal;

      await this.orderRepo.updateById(order.id, {
        subtotal: newSubtotal,
        taxAmount: newTaxAmount,
        totalAmount: newOrderTotal,
        updatedAt: new Date(),
      });

      const invoice = await this.invoiceRepo.findOne({where: {orderId: order.id}} as any);
      if (invoice) {
        await this.invoiceRepo.updateById(invoice.id, {
          subtotal: money(money(invoice.subtotal) + priceDiff),
          // Mirrors the order's own freshly-recomputed total directly,
          // rather than independently diffing invoice.totalAmount — keeps
          // the two from ever drifting apart from separate rounding.
          totalAmount: newOrderTotal,
          // An upgrade raises the bill, so the balance rises with it. Never let
          // it go negative if a downgrade ever produces a negative diff.
          balanceDue: Math.max(0, Math.round(money(invoice.balanceDue) + totalDiff)),
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
          totalAmount: newOrderTotal,
          items,
          updatedAt: new Date(),
        } as any);
      }

      // Price dropped — if the customer already paid more than the new,
      // lower total, that excess is now owed back. Same "no automatic
      // refund" pipeline as Return Item: just record it here; staff pick a
      // payout method from the invoice dialogue and it moves only once that
      // gets its own approval (see selectPayoutMethod/_applyRefundPayout).
      if (priceDiff < 0) {
        const {refundAmount} = await this._computeOverpaymentRefund(order, newOrderTotal);
        if (refundAmount > 0) {
          const refundDue = await this.createRefundDue({
            orderId: order.id,
            customerId: order.customerId!,
            amount: refundAmount,
            reason: RefundReason.DOWNGRADE,
            sourceType: 'order_item',
            sourceId: orderItemId,
            sourceLabel: `Service change on order ${order.orderNumber}`,
          });
          await this._mergeIntoSnapshot(request.id, {refundDueId: refundDue.id});
        }
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

    // Reverting an approved cheque/PDC decision — the PaymentTransaction it
    // created is the only record of that leg (no wallet touch, no other row
    // depends on it), so deleting it outright is simpler than manufacturing a
    // compensating entry for a cheque that never actually cleared.
    if (
      previousStatus === ApprovalRequestStatus.APPROVED &&
      request.entityType === 'order' &&
      (request.type === ApprovalRequestType.CHEQUE_PAYMENT || request.type === ApprovalRequestType.PDC_PAYMENT)
    ) {
      const txnId = snapshot?.chequePaymentTransactionId;
      if (txnId) {
        await this.paymentRepo.deleteById(txnId);
        notes.push(
          `${request.type === ApprovalRequestType.CHEQUE_PAYMENT ? 'Cheque' : 'PDC'} payment transaction reversed — order balance due restored.`,
        );
      } else {
        notes.push(
          'Could not locate the payment transaction created by this approval to reverse — check the order\'s payment history manually.',
        );
      }
    }

    if (snapshot?.refundedToWallet) {
      notes.push(
        `₹${snapshot.refundedToWallet} was refunded to the customer's wallet on return and has NOT been clawed back. Reconcile manually.`,
      );
    }

    // Reverting an approved refund payout: the money (if any) already moved —
    // same "never claw back" stance as the wallet-refund note above. Left as
    // PAID deliberately: _applyRefundPayout() guards on this exact status, so
    // if this reverted request is somehow approved again it becomes a no-op
    // instead of paying out a second time.
    if (
      previousStatus === ApprovalRequestStatus.APPROVED &&
      request.entityType === 'refund_due' &&
      request.type === ApprovalRequestType.REFUND_PAYOUT
    ) {
      const refundDue = await this.refundDueRepo.findOne({where: {id: request.entityId}});
      if (refundDue?.status === RefundDueStatus.PAID) {
        notes.push(
          `This refund had already been paid out via ${refundDue.method ?? 'the chosen method'} and has NOT been clawed back. Re-approving this reverted request will have no further effect — correct the payout manually if it was made in error.`,
        );
      }
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
    snapshot.order = {
      id: order.id,
      subtotal: order.subtotal,
      totalAmount: order.totalAmount,
      taxAmount: order.taxAmount,
    };

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
    // Same area-aware total as _applyUpgradeOnOrderItem, which this quote
    // must match exactly — a measurement item's garments can each carry a
    // different area, so quantity × unit price alone doesn't reflect what
    // approving would actually bill.
    let newTotal: number;
    if (item?.isMeasurement && orderItem) {
      const garments = await this.garmentRepo.find({
        where: {orderItemId: orderItem.id, isDeleted: false} as object,
      });
      const totalArea = garments.reduce(
        (sum, g) => sum + (Number(g.length) || 0) * (Number(g.width) || 0),
        0,
      );
      newTotal = parseFloat((newUnitPrice * totalArea).toFixed(2));
    } else {
      newTotal = parseFloat((newUnitPrice * quantity).toFixed(2));
    }

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
      availableActions: isPending ? CUSTOMER_ACTIONS_BY_TYPE[request.type] ?? [] : [],
      // Only meaningful while resolved. A reverted request is pending again, and
      // its superseded ApprovalAction row must not be shown as the live decision.
      decision:
        !isPending && decision
          ? {action: decision.action, comments: decision.comments ?? null, at: decision.actionDate ?? null}
          : null,
    };
  }

  // ─── Customer-facing view of a process-at-risk request ────────────────────
  // No service/pricing to show — the whole point is staff found nothing safe
  // to switch to either. Just the garment, the risk explanation
  // (requestReason), and whatever photos the store attached when raising it.

  async getRiskView(request: ApprovalRequest): Promise<Record<string, unknown>> {
    const garment = await this.garmentRepo.findOne({where: {id: request.entityId, isDeleted: false}});
    const orderItem = garment
      ? await this.orderItemRepo.findOne({where: {id: garment.orderItemId}})
      : null;
    const item = orderItem?.itemId
      ? await this.itemRepo.findOne({where: {id: orderItem.itemId}})
      : null;

    const [media, decision] = await Promise.all([
      this.resolveMedia(request.mediaIds),
      this.approvalActionRepo.findOne({
        where: {approvalRequestId: request.id},
        order: ['actionDate DESC'],
      }),
    ]);

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

      media,

      availableActions: isPending ? CUSTOMER_ACTIONS_BY_TYPE[request.type] ?? [] : [],
      decision:
        !isPending && decision
          ? {action: decision.action, comments: decision.comments ?? null, at: decision.actionDate ?? null}
          : null,
    };
  }

  /** Dispatch to the right customer-facing view builder for this request's type. */
  async getApprovalView(request: ApprovalRequest): Promise<Record<string, unknown>> {
    return request.type === ApprovalRequestType.PROCESS_AT_RISK
      ? this.getRiskView(request)
      : this.getUpgradeView(request);
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

  /**
   * If every garment on the order has now been returned to the customer,
   * flip the order itself to RETURNED. Mirrors the equivalent check the
   * SalesReturn/credit-note flow runs on its own approve() — this is the
   * other place a garment can end up returned (per-garment approval, not a
   * bulk credit note), so it needs the same order-completion logic.
   */
  private async _maybeMarkOrderReturned(
    orderId: string,
    garmentTagNumber: string | undefined,
    requestId: string,
    performedBy: string,
  ): Promise<void> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) return;
    if (!ORDER_STATUS_TRANSITIONS[order.status!]?.includes(OrderStatus.RETURNED)) return;

    const orderItems = await this.orderItemRepo.find({where: {orderId} as any});
    if (!orderItems.length) return;
    const garments = await this.garmentRepo.find({
      where: {orderItemId: {inq: orderItems.map(i => i.id)}, isDeleted: false} as any,
    });
    const fullyReturned =
      garments.length > 0 && garments.every(g => g.status === GarmentStatus.RETURNED_TO_CUSTOMER);
    if (!fullyReturned) return;

    const {v4} = await import('uuid');
    await this.orderRepo.updateById(orderId, {status: OrderStatus.RETURNED});
    await this.orderStatusHistoryRepo.create({
      id: v4(),
      orderId,
      status: OrderStatus.RETURNED,
      changedAt: new Date(),
      changedBy: performedBy,
      remarks: `Auto-set: every garment on the order has been returned (last: ${garmentTagNumber ?? requestId} via approval ${requestId})`,
    });
  }
}
