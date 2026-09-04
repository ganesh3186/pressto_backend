import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {SalesReturn, SalesReturnStatus} from '../models/sales-return.model';
import {ORDER_STATUS_TRANSITIONS, OrderStatus} from '../models/order-status.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {Order} from '../models/order.model';
import {RefundReason} from '../models/refund-reason.enum';
import {RefundDueStatus} from '../models/refund-due-status.enum';
import {
  CustomerRepository,
  GarmentRepository,
  GstTaxConfigurationRepository,
  InvoiceRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PaymentTransactionRepository,
  SalesReturnRepository,
  ChallanRepository,
  RefundDueRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';
import {ApprovalService} from '../services/approval.service';

/** Coerce a Postgres numeric (returned as a string) to a usable 2dp number. */
function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Order/invoice/challan totals are always a whole rupee. */
function roundRupee(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export class SalesReturnController {
  constructor(
    @repository(SalesReturnRepository) private salesReturnRepo: SalesReturnRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderStatusHistoryRepository) private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GstTaxConfigurationRepository) private gstConfigRepo: GstTaxConfigurationRepository,
    @repository(RefundDueRepository) private refundDueRepo: RefundDueRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @inject('services.approval') private approvalService: ApprovalService,
  ) {}

  /**
   * The current GST rate (CGST + SGST %), same source order creation itself
   * uses. Used instead of deriving an "effective tax rate" back out of the
   * order's own subtotal/taxAmount — those can go stale (e.g. after an
   * Upgrade that changes the subtotal without recomputing tax), which would
   * silently carry that drift into every credit note's GST gross-up.
   */
  private async _resolveGstRate(): Promise<number> {
    const gstConfig = await this.gstConfigRepo.findOne({where: {isActive: true, isDeleted: false} as object});
    return gstConfig ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage) : 0;
  }

  /**
   * Preview exactly what approve() would do to the order's totals, and how
   * much (if any) money needs to leave the order beyond a balance-due
   * reduction. Shared by the global pending-list endpoint (read-only
   * preview) and approve() itself — same numbers, computed once.
   */
  private async _previewCreditNote(
    record: SalesReturn,
    order: Order,
  ): Promise<{newOrderTotal: number; refundAmount: number; newBalanceDue: number}> {
    const creditAmount = money(record.creditAmount);
    const newOrderTotal = Math.max(0, roundRupee(money(order.totalAmount) - creditAmount));

    // Split-aware collected amount, same reasoning as the garment-level return
    // path (ApprovalService._applyReturnEffect): a split child's money lives in
    // allocatedPayment, a split parent's transactions were superseded by its
    // allocated share, and refund entries must never count as collected.
    const payments = await this.paymentRepo.find({where: {orderId: record.orderId}} as any);
    const txnCollected = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? 0 : money(p.amount)),
      0,
    );
    const paidRefunds = payments.reduce(
      (s: number, p: any) => s + (p.transactionType === 'refund' ? money(p.amount) : 0),
      0,
    );
    // A RefundDue not yet paid out (from an earlier Return Item / Upgrade-
    // downgrade / another credit note on this same order) is still money
    // that's spoken for — net it out too, or this credit note would treat it
    // as still-available and double-refund the same amount. See
    // ApprovalService._computeOverpaymentRefund for the identical reasoning.
    const unpaidRefundDues = await this.refundDueRepo.find({
      where: {orderId: record.orderId, status: {inq: [RefundDueStatus.PENDING, RefundDueStatus.REQUESTED]}},
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

    const netPaid = money(collected - alreadyAccountedFor);
    const refundAmount = money(Math.max(0, netPaid - newOrderTotal));
    const newBalanceDue = money(Math.max(0, newOrderTotal - netPaid));

    return {newOrderTotal, refundAmount, newBalanceDue};
  }

  // ─── Create Sales Return ──────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/sales-return')
  @response(200, {description: 'Sales return created'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: {type: 'string'},
              remarks: {type: 'string'},
              returnedItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    orderItemId: {type: 'string'},
                    quantity: {type: 'number'},
                    amount: {type: 'number'},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {
      reason?: string;
      remarks?: string;
      returnedItems?: Array<{orderItemId: string; quantity: number; amount: number}>;
    },
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    // One credit note per order item — a rejected return never actually
    // credited anything, so it doesn't block a fresh attempt; pending or
    // approved ones do.
    const requestedOrderItemIds = [
      ...new Set((body.returnedItems ?? []).map(i => i.orderItemId).filter(Boolean)),
    ];
    if (requestedOrderItemIds.length) {
      const existingReturns = await this.salesReturnRepo.find({
        where: {orderId, status: {neq: SalesReturnStatus.REJECTED}},
      });
      const alreadyCreditedItemIds = new Set<string>();
      for (const existing of existingReturns) {
        for (const line of (existing.returnedItems ?? []) as Array<{orderItemId?: string}>) {
          if (line.orderItemId) alreadyCreditedItemIds.add(line.orderItemId);
        }
      }
      const conflictingIds = requestedOrderItemIds.filter(id => alreadyCreditedItemIds.has(id));
      if (conflictingIds.length) {
        const conflictingOrderItems = await this.orderItemRepo.find({
          where: {id: {inq: conflictingIds}},
        });
        const itemIds = [...new Set(conflictingOrderItems.map(oi => oi.itemId))];
        const items = itemIds.length
          ? await this.itemRepo.find({where: {id: {inq: itemIds}}})
          : [];
        const itemNameById = new Map(items.map(it => [it.id, it.name]));
        const names = conflictingOrderItems.map(oi => itemNameById.get(oi.itemId) ?? 'this item');
        throw new HttpErrors.Conflict(
          `Credit note for ${[...new Set(names)].join(', ')} already exists.`,
        );
      }

      // A garment already returned to the customer via the separate
      // return-item/approval flow (GarmentStatus.RETURNED_TO_CUSTOMER)
      // already had its share of the order's total refunded/adjusted there
      // (see ApprovalService._applyReturnEffect) — a sales-return credit
      // note for the same order item would settle the same amount twice.
      const returnedGarments = await this.garmentRepo.find({
        where: {
          orderItemId: {inq: requestedOrderItemIds},
          status: GarmentStatus.RETURNED_TO_CUSTOMER,
          isDeleted: false,
        } as object,
      });
      if (returnedGarments.length) {
        const returnedOrderItemIds = [...new Set(returnedGarments.map(g => g.orderItemId))];
        const returnedOrderItems = await this.orderItemRepo.find({
          where: {id: {inq: returnedOrderItemIds}},
        });
        const itemIds = [...new Set(returnedOrderItems.map(oi => oi.itemId))];
        const items = itemIds.length
          ? await this.itemRepo.find({where: {id: {inq: itemIds}}})
          : [];
        const itemNameById = new Map(items.map(it => [it.id, it.name]));
        const names = returnedOrderItems.map(oi => itemNameById.get(oi.itemId) ?? 'this item');
        throw new HttpErrors.Conflict(
          `${[...new Set(names)].join(', ')} already returned to the customer — cannot create a sales return for it.`,
        );
      }
    }

    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);

    // GST is applied once, at the order level (see order.service.ts's
    // createOrder), never per line item — OrderItem.totalPrice, and so the
    // per-item `amount` the frontend sends here, is pre-tax. Gross the
    // aggregate up by the CURRENT real GST rate before storing it as
    // creditAmount, so the credit note (and the wallet refund it drives in
    // approve()) matches what the customer actually paid, GST included —
    // not just the item's pre-tax price.
    //
    // Deliberately not derived from the order's own taxAmount/subtotal
    // ratio (an "effective tax rate") — that pair can go stale relative to
    // each other (e.g. after an Upgrade that changes the subtotal), and an
    // effective-rate derivation would silently inherit that drift into
    // every credit note's own GST gross-up, over- or under-crediting the
    // customer. OrderService.splitOrder() still does this the old,
    // stale-prone way — flagging for a follow-up, not fixed here.
    const preTaxCreditAmount = (body.returnedItems ?? []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const gstRate = await this._resolveGstRate();
    const creditAmount = preTaxCreditAmount * (1 + gstRate / 100);

    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.salesReturnRepo.count();
    const creditNoteNumber = `CN-${ym}-${String(count.count + 1).padStart(5, '0')}`;

    const {v4} = await import('uuid');
    const salesReturn = await this.salesReturnRepo.create({
      id: v4(),
      orderId,
      invoiceId: invoice?.id,
      customerId: order.customerId,
      creditNoteNumber,
      reason: body.reason,
      remarks: body.remarks,
      returnedItems: body.returnedItems ?? [],
      creditAmount: parseFloat(creditAmount.toFixed(2)),
      status: SalesReturnStatus.PENDING,
      requestedBy: currentUser[securityId],
    } as Partial<SalesReturn>);

    return {message: 'Sales return created. Credit note pending approval.', salesReturn};
  }

  // ─── Get Credit Note ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/credit-note')
  @response(200, {description: 'Credit note for an order'})
  async getCreditNote(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const salesReturn = await this.salesReturnRepo.findOne({
      where: {orderId} as any,
      order: ['createdAt DESC'],
    } as any);

    if (!salesReturn) throw new HttpErrors.NotFound('No sales return / credit note found for this order.');
    return {creditNote: salesReturn};
  }

  // ─── List Sales Returns ───────────────────────────────────────────────────
  // All returns for an order, any status — lets the New Sales Return dialog
  // know which order items already have one (see the create() guard above),
  // since getCreditNote only ever surfaces the single most recent record.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/sales-returns')
  @response(200, {description: 'All sales returns for an order'})
  async listSalesReturns(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const salesReturns = await this.salesReturnRepo.find({
      where: {orderId},
      order: ['createdAt DESC'],
    });

    return {salesReturns};
  }

  // ─── List Credit Notes (global) ────────────────────────────────────────────
  // Cross-order view for the Finance Approvals screen — listSalesReturns()
  // above only helps once you already know which order to look at.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/sales-returns')
  @response(200, {description: 'Sales returns across all orders, optionally filtered by status'})
  async listAll(
    // Comma-separated (e.g. "pending,approved,rejected"), same convention as
    // approval-requests' `type` filter — omit entirely for every status, so
    // finance can see what they've already approved/rejected, not just
    // what's still pending.
    @param.query.string('status') status?: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    const statuses = (status ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean) as SalesReturnStatus[];

    const salesReturns = await this.salesReturnRepo.find({
      where: statuses.length ? {status: statuses.length > 1 ? {inq: statuses} : statuses[0]} : {},
      order: ['createdAt DESC'],
    });
    if (!salesReturns.length) return {salesReturns: []};

    const orderIds = [...new Set(salesReturns.map(sr => sr.orderId))];
    const orders = await this.orderRepo.find({where: {id: {inq: orderIds}}});
    const orderById = new Map(orders.map(o => [o.id, o]));

    const scope = await this.storeScopeService.resolve(currentUser!);
    // Also allow orders reachable via an active inter-store transfer grant
    // to this scope — additive, doesn't narrow anything the direct
    // storeId check already allowed.
    const transferGrantedOrderIds = scope.global
      ? []
      : await this.storeScopeService.transferGrantedOrderIds(scope.storeIds);
    const grantedOrderIdSet = new Set(transferGrantedOrderIds.map(String));
    const inScope = scope.global
      ? salesReturns
      : salesReturns.filter(sr => {
          if (grantedOrderIdSet.has(String(sr.orderId))) return true;
          const order = orderById.get(sr.orderId);
          return order ? this.storeScopeService.allows(scope, order.storeId) : false;
        });

    const customerIds = [...new Set(inScope.map(sr => sr.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await this.customerRepo.find({where: {id: {inq: customerIds}}})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    const rows = await Promise.all(
      inScope.map(async sr => {
        const order = orderById.get(sr.orderId);
        const customer = customerById.get(sr.customerId);
        const preview = order
          ? await this._previewCreditNote(sr, order)
          : {refundAmount: 0, newBalanceDue: 0};
        return {
          id: sr.id,
          creditNoteNumber: sr.creditNoteNumber,
          orderId: sr.orderId,
          orderNumber: order?.orderNumber ?? null,
          customerId: sr.customerId,
          customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : null,
          reason: sr.reason,
          remarks: sr.remarks,
          creditAmount: sr.creditAmount,
          status: sr.status,
          requestedBy: sr.requestedBy,
          createdAt: sr.createdAt,
          refundAmount: preview.refundAmount,
          newBalanceDue: preview.newBalanceDue,
        };
      }),
    );

    return {salesReturns: rows};
  }

  // ─── Approve Sales Return ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/sales-returns/{id}/approve')
  @response(200, {description: 'Sales return approved'})
  async approve(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const record = await this.salesReturnRepo.findById(id);
    if (!record) throw new HttpErrors.NotFound('Sales return not found.');
    if (record.status !== SalesReturnStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Sales return is already ${record.status}.`);
    }

    const order = await this.orderRepo.findOne({where: {id: record.orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const {v4} = await import('uuid');
    // Approving the credit note no longer decides how (or whether) a
    // resulting refund gets paid out — that's a separate, later decision.
    // If the math below says a refund is due, this just records it as a
    // RefundDue; staff pick wallet/bank/cash from the order's invoice
    // dialogue afterward, and the money only moves once that gets its own
    // approval (see ApprovalService.selectPayoutMethod/_applyRefundPayout).
    const creditAmount = money(record.creditAmount);
    const {newOrderTotal, refundAmount, newBalanceDue} = await this._previewCreditNote(record, order);

    // creditAmount is tax-INCLUSIVE (create() grosses it up by GST) — every
    // *subtotal* field here is pre-tax, so subtracting creditAmount from
    // one directly overshoots by the tax portion (can even drive subtotal
    // negative). Reverse the same gross-up create() applied, using the
    // current GST rate, to get back the pre-tax portion to actually
    // subtract from subtotal. totalAmount/balanceDue are unaffected by this
    // — those are already correctly tax-inclusive-minus-tax-inclusive via
    // _previewCreditNote above.
    const gstRate = await this._resolveGstRate();
    const preTaxCreditAmount = gstRate > 0 ? money(creditAmount / (1 + gstRate / 100)) : creditAmount;
    const newSubtotal = money(money(order.subtotal) - preTaxCreditAmount);
    // Recompute tax fresh from the new subtotal rather than leaving
    // order.taxAmount stale — a stale taxAmount would corrupt a *later*
    // credit note on this same order the same way this one was corrupted
    // by an earlier Upgrade (see approval.service.ts's
    // _applyUpgradeOnOrderItem, fixed the same way).
    const newTaxableAmount = money(newSubtotal - money(order.discountAmount));
    const newTaxAmount = gstRate > 0 ? money((newTaxableAmount * gstRate) / 100) : 0;

    await this.orderRepo.updateById(record.orderId, {
      subtotal: newSubtotal,
      taxAmount: newTaxAmount,
      totalAmount: newOrderTotal,
      updatedAt: new Date(),
    } as any);

    if (record.invoiceId) {
      const invoice = await this.invoiceRepo.findById(record.invoiceId);
      if (invoice) {
        await this.invoiceRepo.updateById(invoice.id, {
          subtotal: money(money(invoice.subtotal) - preTaxCreditAmount),
          totalAmount: newOrderTotal,
          balanceDue: newBalanceDue,
          updatedAt: new Date(),
        } as any);
      }
    }

    // Always reflect the reduced order value on the challan if it exists
    const challan = await this.challanRepo.findOne({where: {orderId: record.orderId}} as any);
    if (challan) {
      await this.challanRepo.updateById(challan.id, {
        totalAmount: newOrderTotal,
        subtotal: money(money(challan.subtotal) - preTaxCreditAmount),
        updatedAt: new Date(),
      } as any);
    }

    if (refundAmount > 0) {
      await this.approvalService.createRefundDue({
        orderId: record.orderId,
        customerId: record.customerId,
        amount: refundAmount,
        reason: RefundReason.SALES_RETURN,
        sourceType: 'sales_return',
        sourceId: record.id,
        sourceLabel: `Credit Note ${record.creditNoteNumber}`,
      });
    }

    await this.salesReturnRepo.updateById(id, {
      status: SalesReturnStatus.APPROVED,
      resolvedBy: currentUser[securityId],
      resolvedAt: new Date(),
      // creditAppliedAs is filled in later, once a payout method is actually
      // chosen and executed (see ApprovalService._applyRefundPayout) — left
      // unset here when a refund is due; stays unset entirely when the
      // credit was fully absorbed into a lower balance due.
    } as Partial<SalesReturn>);

    // If every item on the order now has an approved return covering its full
    // quantity, the order itself is done — nothing is left to deliver/track.
    // ORDER_STATUS_TRANSITIONS only allows this jump from a post-fulfillment
    // state, so an order returned before it ever reached that stage is left
    // as-is rather than forced into an invalid transition.
    const orderItems = await this.orderItemRepo.find({where: {orderId: record.orderId} as any});
    const approvedReturns = await this.salesReturnRepo.find({
      where: {orderId: record.orderId, status: SalesReturnStatus.APPROVED} as any,
    });
    const returnedQtyByItem = new Map<string, number>();
    for (const ret of approvedReturns) {
      for (const line of (ret.returnedItems ?? []) as Array<{orderItemId?: string; quantity?: number}>) {
        if (!line.orderItemId) continue;
        returnedQtyByItem.set(
          line.orderItemId,
          (returnedQtyByItem.get(line.orderItemId) ?? 0) + (Number(line.quantity) || 0),
        );
      }
    }
    const fullyReturned =
      orderItems.length > 0 &&
      orderItems.every(oi => (returnedQtyByItem.get(oi.id) ?? 0) >= (Number(oi.quantity) || 0));

    if (fullyReturned && ORDER_STATUS_TRANSITIONS[order.status!]?.includes(OrderStatus.RETURNED)) {
      await this.orderRepo.updateById(record.orderId, {status: OrderStatus.RETURNED});
      await this.statusHistoryRepo.create({
        id: v4(),
        orderId: record.orderId,
        status: OrderStatus.RETURNED,
        changedAt: new Date(),
        changedBy: currentUser[securityId],
        remarks: `Auto-set: all items returned via credit note ${record.creditNoteNumber}`,
      });
    }

    return {message: 'Sales return approved. Credit note issued.', creditNoteNumber: record.creditNoteNumber};
  }

  // ─── Reject Sales Return ───────────────────────────────────────────────────
  // The only other place a PENDING credit note can go — status was already
  // in the enum, it was just never reachable via any endpoint.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/sales-returns/{id}/reject')
  @response(200, {description: 'Sales return rejected'})
  async reject(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body?: {remarks?: string},
  ): Promise<object> {
    const record = await this.salesReturnRepo.findById(id);
    if (!record) throw new HttpErrors.NotFound('Sales return not found.');
    if (record.status !== SalesReturnStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Sales return is already ${record.status}.`);
    }

    await this.salesReturnRepo.updateById(id, {
      status: SalesReturnStatus.REJECTED,
      resolvedBy: currentUser[securityId],
      resolvedAt: new Date(),
      remarks: body?.remarks ?? record.remarks,
    } as Partial<SalesReturn>);

    return {message: 'Sales return rejected.', creditNoteNumber: record.creditNoteNumber};
  }
}
