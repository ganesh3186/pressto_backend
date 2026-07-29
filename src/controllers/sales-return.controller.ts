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
import {
  InvoiceRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  SalesReturnRepository,
  ChallanRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

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
    const creditAppliedAs = body.creditAppliedAs ?? 'adjustment';

    if (creditAppliedAs === 'wallet') {
      let wallet = await this.walletRepo.findOne({where: {customerId: record.customerId}});
      if (!wallet) {
        wallet = await this.walletRepo.create({
          id: v4(),
          customerId: record.customerId,
          currentBalance: 0,
        });
      }
      const creditAmount = Number(record.creditAmount) || 0;
      const newBalance = parseFloat(
        ((Number(wallet.currentBalance) || 0) + creditAmount).toFixed(2),
      );
      await this.walletRepo.updateById(wallet.id, {
        currentBalance: newBalance,
        updatedAt: new Date(),
      });

      await this.walletTransactionRepo.create({
        id: v4(),
        walletId: wallet.id,
        transactionType: WalletTransactionType.CREDIT,
        amount: creditAmount,
        referenceType: ReferenceType.REFUND,
        referenceId: record.orderId,
        remarks: `Sales Return Credit Note: ${record.creditNoteNumber}`,
        transactionDate: new Date(),
      });
    } else if (creditAppliedAs === 'adjustment') {
      if (record.invoiceId) {
        const invoice = await this.invoiceRepo.findById(record.invoiceId);
        if (invoice) {
          const newBalance = Math.max(0, (invoice.balanceDue ?? 0) - Number(record.creditAmount));
          await this.invoiceRepo.updateById(invoice.id, {
            balanceDue: newBalance,
          } as any);
        }
      }
    }

    // Always reflect the reduced order value on the challan if it exists
    const challan = await this.challanRepo.findOne({where: {orderId: record.orderId}} as any);
    if (challan) {
      const newTotal = Math.max(0, (challan.totalAmount ?? 0) - Number(record.creditAmount));
      const newSubtotal = Math.max(0, (challan.subtotal ?? 0) - Number(record.creditAmount));
      await this.challanRepo.updateById(challan.id, {
        totalAmount: parseFloat(newTotal.toFixed(2)),
        subtotal: parseFloat(newSubtotal.toFixed(2)),
        updatedAt: new Date(),
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
