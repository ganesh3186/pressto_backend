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
import {OrderItemRepository} from '../repositories/order-item.repository';
import {OrderRepository} from '../repositories/order.repository';
import {PaymentTransactionRepository} from '../repositories/payment-transaction.repository';
import {WalletRepository} from '../repositories/wallet.repository';
import {WalletTransactionRepository} from '../repositories/wallet-transaction.repository';
import {ApprovalActionType} from '../models/approval-action-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {ProcessLogStatus} from '../models/process-log-status.enum';
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
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
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
      await this._applyRejectEffect(request, params.performedBy);
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

    // One garment = one piece of its order item.
    const returnedAmount = parseFloat((Number(orderItem.unitPrice) || 0).toFixed(2));
    if (returnedAmount <= 0) return;

    // Reduce the order item (one piece removed from billing).
    const newQty = Math.max(0, (Number(orderItem.quantity) || 0) - 1);
    const newItemTotal = parseFloat(((Number(orderItem.unitPrice) || 0) * newQty).toFixed(2));
    await this.orderItemRepo.updateById(orderItem.id, {
      quantity: newQty,
      totalPrice: newItemTotal,
      updatedAt: new Date(),
    });

    // Reduce order totals.
    const newSubtotal = Math.max(0, parseFloat(((Number(order.subtotal) || 0) - returnedAmount).toFixed(2)));
    const newTotal = Math.max(0, parseFloat(((Number(order.totalAmount) || 0) - returnedAmount).toFixed(2)));
    await this.orderRepo.updateById(order.id, {
      subtotal: newSubtotal,
      totalAmount: newTotal,
      updatedAt: new Date(),
    });

    // Reflect on invoice + challan (reduce the returned line + totals).
    await this._reduceBillingDocsForReturn(order.id, orderItem.id, returnedAmount);

    // Refund: if the customer already paid more than the new total, credit the
    // overpayment to their wallet (credit note). Otherwise the reduction simply
    // lowers the remaining balance (reflected on the invoice above).
    const payments = await this.paymentRepo.find({where: {orderId: order.id}} as any);
    const amountReceived = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const overpaid = parseFloat((amountReceived - newTotal).toFixed(2));
    if (overpaid > 0) {
      await this._creditWallet(
        order.customerId!,
        overpaid,
        performedBy,
        `Return credit — garment ${garment.garmentTagNumber} (order ${order.orderNumber})`,
      );
    }

    await this.auditService.log({
      entityType: 'order_item',
      entityId: orderItem.id,
      actionType: 'item_returned',
      performedBy,
      before: {quantity: orderItem.quantity, totalPrice: orderItem.totalPrice},
      after: {quantity: newQty, totalPrice: newItemTotal, refundedToWallet: overpaid > 0 ? overpaid : 0},
      remarks: `Return via approval ${request.id}${overpaid > 0 ? ` — ₹${overpaid} credited to wallet` : ''}`,
    });
  }

  // Reduce the returned item's line + document totals on invoice and challan.
  private async _reduceBillingDocsForReturn(orderId: string, orderItemId: string, amount: number): Promise<void> {
    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (invoice) {
      const items = this._reduceItemQtyInDocItems(invoice.items as any[], orderItemId);
      const newSubtotal = Math.max(0, parseFloat(((Number(invoice.subtotal) || 0) - amount).toFixed(2)));
      const newTotal = Math.max(0, parseFloat(((Number(invoice.totalAmount) || 0) - amount).toFixed(2)));
      const received = Number((invoice as any).amountReceived) || 0;
      const newBalance = Math.max(0, parseFloat((newTotal - received).toFixed(2)));
      await this.invoiceRepo.updateById(invoice.id, {
        items,
        subtotal: newSubtotal,
        totalAmount: newTotal,
        balanceDue: newBalance,
        updatedAt: new Date(),
      } as any);
    }

    const challan = await this.challanRepo.findOne({where: {orderId}} as any);
    if (challan) {
      const items = this._reduceItemQtyInDocItems(challan.items as any[], orderItemId);
      const newSubtotal = Math.max(0, parseFloat(((Number(challan.subtotal) || 0) - amount).toFixed(2)));
      const newTotal = Math.max(0, parseFloat(((Number(challan.totalAmount) || 0) - amount).toFixed(2)));
      await this.challanRepo.updateById(challan.id, {
        items,
        subtotal: newSubtotal,
        totalAmount: newTotal,
        updatedAt: new Date(),
      } as any);
    }
  }

  private _reduceItemQtyInDocItems(items: any[] | undefined, orderItemId: string): any[] {
    const list = [...(items ?? [])];
    const idx = list.findIndex(i => i.orderItemId === orderItemId);
    if (idx !== -1) {
      const it = list[idx];
      const newQty = Math.max(0, (Number(it.quantity) || 0) - 1);
      list[idx] = {
        ...it,
        quantity: newQty,
        totalPrice: parseFloat(((Number(it.unitPrice) || 0) * newQty).toFixed(2)),
      };
    }
    return list;
  }

  // Credit an amount to the customer's wallet + log a wallet transaction (credit note trail).
  private async _creditWallet(customerId: string, amount: number, performedBy: string, remarks: string): Promise<void> {
    const {v4} = await import('uuid');
    let wallet = await this.walletRepo.findOne({where: {customerId}} as any);
    if (!wallet) {
      wallet = await this.walletRepo.create({id: v4(), customerId, balance: 0, currentBalance: 0} as any);
    }
    const current = Number((wallet as any).currentBalance ?? (wallet as any).balance ?? 0) || 0;
    const newBalance = parseFloat((current + amount).toFixed(2));
    await this.walletRepo.updateById(wallet.id, {currentBalance: newBalance, balance: newBalance} as any);
    await this.walletTransactionRepo.create({
      id: v4(),
      walletId: wallet.id,
      customerId,
      type: 'credit',
      amount,
      remarks,
      recordedBy: performedBy,
    } as any);
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

  private async _applyRejectEffect(request: ApprovalRequest, performedBy: string): Promise<void> {
    if (request.entityType !== 'garment') return;

    // Upgrade rejected: restore garment off on_hold — go back to in_inspection
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
        await this._updateGarmentStatus(request.entityId, restoreStatus, performedBy,
          `Upgrade rejected — restored to ${restoreStatus}`);
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

    const oldTotalPrice = orderItem.totalPrice ?? 0;
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
      const newSubtotal = (order.subtotal ?? 0) + priceDiff;
      const newTotal = (order.totalAmount ?? 0) + priceDiff;
      await this.orderRepo.updateById(order.id, {
        subtotal: parseFloat(newSubtotal.toFixed(2)),
        totalAmount: parseFloat(newTotal.toFixed(2)),
        updatedAt: new Date(),
      });

      const invoice = await this.invoiceRepo.findOne({where: {orderId: order.id}} as any);
      if (invoice) {
        const newInvoiceSubtotal = (invoice.subtotal ?? 0) + priceDiff;
        const newInvoiceTotal = (invoice.totalAmount ?? 0) + priceDiff;
        const newBalanceDue = (invoice.balanceDue ?? 0) + priceDiff;
        await this.invoiceRepo.updateById(invoice.id, {
          subtotal: parseFloat(newInvoiceSubtotal.toFixed(2)),
          totalAmount: parseFloat(newInvoiceTotal.toFixed(2)),
          balanceDue: parseFloat(newBalanceDue.toFixed(2)),
          updatedAt: new Date(),
        } as any);
      }

      const challan = await this.challanRepo.findOne({where: {orderId: order.id}} as any);
      if (challan) {
        const newChallanSubtotal = (challan.subtotal ?? 0) + priceDiff;
        const newChallanTotal = (challan.totalAmount ?? 0) + priceDiff;
        
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
          subtotal: parseFloat(newChallanSubtotal.toFixed(2)),
          totalAmount: parseFloat(newChallanTotal.toFixed(2)),
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
