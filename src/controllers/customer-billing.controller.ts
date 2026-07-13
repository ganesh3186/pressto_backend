import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {PresstoDataSource} from '../datasources';
import {authorize} from '../authorization';
import {
  CustomerRepository,
  InvoiceRepository,
  OrderRepository,
  PaymentTransactionRepository,
  WalletRepository,
} from '../repositories';

/** Coerce a Postgres numeric (which the driver returns as a string) to a 2dp number. */
function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export class CustomerBillingController {
  constructor(
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  // ─── Pending Invoices (Club & Pay list) ───────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:read']})
  @get('/customers/{customerId}/pending-invoices')
  @response(200, {description: 'All unpaid or partially-paid invoices for the customer'})
  async pendingInvoices(@param.path.string('customerId') customerId: string): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const orders = await this.orderRepo.find({where: {customerId, isDeleted: false} as any});
    const orderIds = orders.map(o => o.id);

    if (!orderIds.length) return {pendingInvoices: [], totalDue: 0};

    const invoices = await this.invoiceRepo.find({
      where: {orderId: {inq: orderIds}} as any,
    });

    const pending = invoices.filter(inv => (inv.balanceDue ?? 0) > 0);

    const orderMap = new Map(orders.map(o => [o.id, o]));

    const enriched = pending.map(inv => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      orderId: inv.orderId,
      orderNumber: (orderMap.get(inv.orderId) as any)?.orderNumber ?? null,
      totalAmount: money(inv.totalAmount),
      amountReceived: money(inv.amountReceived),
      balanceDue: money(inv.balanceDue),
      createdAt: inv.createdAt,
    }));

    const totalDue = enriched.reduce((s, i) => s + i.balanceDue, 0);

    return {pendingInvoices: enriched, totalDue: money(totalDue)};
  }

  // ─── Club & Pay ───────────────────────────────────────────────────────────
  // Single payment against multiple pending invoices.
  // Allocates oldest-first until payment amount is exhausted.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/customers/{customerId}/club-pay')
  @response(200, {description: 'Club & Pay payment applied'})
  async clubPay(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount', 'paymentMode'],
            properties: {
              amount: {type: 'number'},
              paymentMode: {type: 'string'},
              referenceNumber: {type: 'string'},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {amount: number; paymentMode: string; referenceNumber?: string; remarks?: string},
  ): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const orders = await this.orderRepo.find({where: {customerId, isDeleted: false} as any});
    const orderIds = orders.map(o => o.id);
    if (!orderIds.length) throw new HttpErrors.BadRequest('Customer has no orders.');

    const invoices = await this.invoiceRepo.find({
      where: {orderId: {inq: orderIds}} as any,
      order: ['createdAt ASC'],
    });

    const pending = invoices.filter(inv => (inv.balanceDue ?? 0) > 0);
    if (!pending.length) throw new HttpErrors.BadRequest('No pending balance found for this customer.');

    const {v4} = await import('uuid');
    let remaining = Number(body.amount);
    const allocations: Array<{invoiceId: string; invoiceNumber: string; orderId: string; allocated: number}> = [];

    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED'} as any);

    try {
      for (const inv of pending) {
        if (remaining <= 0) break;
        // Postgres numeric columns arrive as strings — coerce before any maths.
        // `"120" + 50` concatenates; only subtraction coerces silently.
        const due = money(inv.balanceDue);
        const allocated = Math.min(remaining, due);
        remaining = money(remaining - allocated);

        const newBalance = money(due - allocated);
        const newReceived = money(money(inv.amountReceived) + allocated);

        await this.invoiceRepo.updateById(
          inv.id,
          {
            amountReceived: newReceived,
            balanceDue: newBalance,
          } as any,
          {transaction: tx}
        );

        // Record payment transaction
        await this.paymentRepo.create(
          {
            id: v4(),
            orderId: inv.orderId,
            amount: allocated,
            paymentMode: body.paymentMode,
            referenceNumber: body.referenceNumber,
            remarks: `Club & Pay: ${body.remarks ?? ''}`.trim(),
            recordedBy: currentUser[securityId],
            paidAt: new Date(),
          } as any,
          {transaction: tx}
        );

        allocations.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          orderId: inv.orderId,
          allocated: parseFloat(allocated.toFixed(2)),
        });
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    return {
      message: 'Club & Pay applied.',
      totalPaid: parseFloat(body.amount.toFixed(2)),
      unallocated: remaining,
      allocations,
    };
  }

  // ─── POS Summary ──────────────────────────────────────────────────────────
  // Single call for the counter screen — customer info, wallet, last 5 orders, pending balance.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:read']})
  @get('/customers/{customerId}/pos-summary')
  @response(200, {description: 'POS counter summary for customer'})
  async posSummary(@param.path.string('customerId') customerId: string): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const wallet = await this.walletRepo.findOne({where: {customerId}} as any);

    const orders = await this.orderRepo.find({
      where: {customerId, isDeleted: false} as any,
      order: ['createdAt DESC'],
      limit: 5,
    });

    // Pending balance across all orders
    const allOrders = await this.orderRepo.find({where: {customerId, isDeleted: false} as any});
    const allOrderIds = allOrders.map(o => o.id);
    let totalPendingBalance = 0;

    if (allOrderIds.length) {
      const allInvoices = await this.invoiceRepo.find({
        where: {orderId: {inq: allOrderIds}} as any,
      });
      totalPendingBalance = allInvoices.reduce((s, inv) => s + money(inv.balanceDue), 0);
    }

    const c = customer as any;
    return {
      customerId,
      name: c.fullName ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() ?? 'Customer',
      phone: c.phone ?? c.mobile ?? '',
      customerType: c.customerType?.name ?? null,
      customerLabel: c.customerLabel?.name ?? null,
      sensitivityScore: c.sensitivity ?? c.sensitivityScore ?? 0,
      preferredPaymentMode: c.preferredPaymentMode ?? null,
      specialInstructions: c.specialInstructions ?? c.notes ?? null,
      // The Wallet model's field is `currentBalance`, not `balance` — reading the
      // latter through an `as any` made this silently report ₹0 for every customer.
      walletBalance: money(wallet?.currentBalance),
      totalPendingBalance: money(totalPendingBalance),
      last5Orders: orders.map(o => ({
        orderId: o.id,
        orderNumber: (o as any).orderNumber,
        status: o.status,
        totalAmount: (o as any).totalAmount ?? 0,
        createdAt: o.createdAt,
        deliveryDate: (o as any).deliveryDate ?? null,
      })),
    };
  }
}
