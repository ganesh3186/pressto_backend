import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {SalesReturn, SalesReturnStatus} from '../models/sales-return.model';
import {WalletTransactionType} from '../models/wallet-transaction-type.enum';
import {ReferenceType} from '../models/reference-type.enum';
import {ORDER_STATUS_TRANSITIONS, OrderStatus} from '../models/order-status.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {Order} from '../models/order.model';
import {
  CustomerRepository,
  GarmentRepository,
  InvoiceRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PaymentTransactionRepository,
  SalesReturnRepository,
  ChallanRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

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
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @repository(OrderStatusHistoryRepository) private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

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

    const netPaid = money(collected - alreadyRefunded);
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

    const creditAmount = (body.returnedItems ?? []).reduce((s, i) => s + (Number(i.amount) || 0), 0);

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

  // ─── List Pending Credit Notes (global) ───────────────────────────────────
  // Cross-order view for the Finance Approvals screen — listSalesReturns()
  // above only helps once you already know which order to look at.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/sales-returns')
  @response(200, {description: 'Sales returns across all orders, filtered by status'})
  async listAll(
    @param.query.string('status') status?: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    const salesReturns = await this.salesReturnRepo.find({
      where: {status: (status as SalesReturnStatus) ?? SalesReturnStatus.PENDING},
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
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              creditAppliedAs: {type: 'string', enum: ['wallet', 'adjustment', 'refund']},
              payoutReference: {type: 'string', description: 'Bank UTR / cheque number used for an external refund'},
              payoutNote: {type: 'string', description: 'Free-text note for an external refund'},
            },
          },
        },
      },
    })
    body: {creditAppliedAs?: string; payoutReference?: string; payoutNote?: string},
  ): Promise<object> {
    const record = await this.salesReturnRepo.findById(id);
    if (!record) throw new HttpErrors.NotFound('Sales return not found.');
    if (record.status !== SalesReturnStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Sales return is already ${record.status}.`);
    }

    const order = await this.orderRepo.findOne({where: {id: record.orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const {v4} = await import('uuid');
    // `creditAppliedAs` never decides WHETHER a refund happens — that's fully
    // automatic, derived below from whether the customer has already paid
    // more than the order will owe after the return. It DOES decide WHERE
    // that money goes, once the math says a refund is due: 'refund' books it
    // as an external payout (bank transfer/cash — finance executes it
    // outside this app); anything else (including the default, and
    // 'adjustment' when a refund happens to be due anyway) credits the
    // wallet, exactly as before.
    const creditAppliedAs = body.creditAppliedAs ?? 'adjustment';
    const creditAmount = money(record.creditAmount);
    const {newOrderTotal, refundAmount, newBalanceDue} = await this._previewCreditNote(record, order);

    await this.orderRepo.updateById(record.orderId, {
      subtotal: money(money(order.subtotal) - creditAmount),
      totalAmount: newOrderTotal,
      updatedAt: new Date(),
    } as any);

    if (record.invoiceId) {
      const invoice = await this.invoiceRepo.findById(record.invoiceId);
      if (invoice) {
        await this.invoiceRepo.updateById(invoice.id, {
          subtotal: money(money(invoice.subtotal) - creditAmount),
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
        subtotal: money(money(challan.subtotal) - creditAmount),
        updatedAt: new Date(),
      } as any);
    }

    if (refundAmount > 0 && creditAppliedAs === 'refund') {
      // External payout — finance moves the money outside the wallet (bank
      // transfer, cash, etc). This app does not integrate a payment gateway
      // payout; this books the fact that money is owed externally so it's
      // visible/reconcilable in the order's payment history, same as the
      // wallet path below, just without touching the wallet.
      await this.paymentRepo.create({
        id: v4(),
        orderId: record.orderId,
        paymentMode: PaymentMode.BANK_TRANSFER,
        transactionType: 'refund',
        amount: refundAmount,
        transactionReference: body.payoutReference,
        gatewayResponse:
          body.payoutNote ?? 'External refund — paid out via bank transfer, not credited to wallet.',
        paymentDate: new Date(),
      });
    } else if (refundAmount > 0) {
      let wallet = await this.walletRepo.findOne({where: {customerId: record.customerId}});
      if (!wallet) {
        wallet = await this.walletRepo.create({
          id: v4(),
          customerId: record.customerId,
          currentBalance: 0,
        });
      }
      const newBalance = money(money(wallet.currentBalance) + refundAmount);
      await this.walletRepo.updateById(wallet.id, {
        currentBalance: newBalance,
        updatedAt: new Date(),
      });

      await this.walletTransactionRepo.create({
        id: v4(),
        walletId: wallet.id,
        transactionType: WalletTransactionType.CREDIT,
        amount: refundAmount,
        referenceType: ReferenceType.REFUND,
        referenceId: record.orderId,
        remarks: `Sales Return Credit Note: ${record.creditNoteNumber}`,
        transactionDate: new Date(),
      });

      // Visible refund entry in the order's payment history — excluded from
      // `collected` above, so a second return on this order still nets out.
      await this.paymentRepo.create({
        id: v4(),
        orderId: record.orderId,
        paymentMode: PaymentMode.WALLET,
        transactionType: 'refund',
        amount: refundAmount,
        paymentDate: new Date(),
      } as any);
    }

    await this.salesReturnRepo.updateById(id, {
      status: SalesReturnStatus.APPROVED,
      resolvedBy: currentUser[securityId],
      resolvedAt: new Date(),
      creditAppliedAs: creditAppliedAs,
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
