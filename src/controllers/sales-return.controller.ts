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
import {PaymentMode} from '../models/payment-mode.enum';
import {
  InvoiceRepository,
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
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @repository(OrderStatusHistoryRepository) private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

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
            },
          },
        },
      },
    })
    body: {creditAppliedAs?: string},
  ): Promise<object> {
    const record = await this.salesReturnRepo.findById(id);
    if (!record) throw new HttpErrors.NotFound('Sales return not found.');
    if (record.status !== SalesReturnStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Sales return is already ${record.status}.`);
    }

    const order = await this.orderRepo.findOne({where: {id: record.orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const {v4} = await import('uuid');
    // `creditAppliedAs` is recorded for history but no longer decides WHETHER
    // a refund happens — it can't be a manual choice: whether this credit
    // surfaces as a smaller balance due or an actual refund depends on
    // whether the customer has already paid more than the order will owe
    // after the return, computed below. (It also used to silently no-op for
    // 'refund' — there was never a branch for it — and 'wallet' refunded the
    // full creditAmount unconditionally, which could refund money the
    // customer hadn't actually paid on a partially-paid order.)
    const creditAppliedAs = body.creditAppliedAs ?? 'adjustment';
    const creditAmount = money(record.creditAmount);

    // The order's total drops by exactly the credited amount — a customer
    // should never be left owing (or having paid) for a returned item.
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

    if (refundAmount > 0) {
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
}
