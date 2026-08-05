import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {PresstoDataSource} from '../datasources';
import {authorize} from '../authorization';
import {Invoice, InvoiceStatus} from '../models/invoice.model';
import {OrderStatus} from '../models/order-status.enum';
import {
  CustomerRepository,
  InvoiceOrderLinkRepository,
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
    @repository(InvoiceOrderLinkRepository) private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
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

        // Record payment transaction. Field names must match PaymentTransaction
        // exactly (transactionReference/paymentDate, not referenceNumber/paidAt)
        // — the model has no remarks/recordedBy column at all, so the Club & Pay
        // note is folded into gatewayResponse (a free-text field) instead of
        // being silently dropped.
        await this.paymentRepo.create(
          {
            id: v4(),
            orderId: inv.orderId,
            amount: allocated,
            paymentMode: body.paymentMode,
            transactionReference: body.referenceNumber,
            gatewayResponse: `Club & Pay: ${body.remarks ?? ''}`.trim(),
            paymentDate: new Date(),
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

  // ─── On Account: Billable Orders ──────────────────────────────────────────
  // Delivered orders for a business (on-account) customer that haven't been
  // invoiced yet — individually, or as part of an earlier consolidated batch.
  // These customers skip the usual "must be paid before handover" rule
  // (see OrderService.handoverInStore), so this is how the debt actually
  // surfaces for billing later.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:read']})
  @get('/customers/{customerId}/on-account/billable-orders')
  @response(200, {description: 'Delivered, not-yet-invoiced orders for an on-account customer'})
  async billableOrders(@param.path.string('customerId') customerId: string): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const orders = await this.orderRepo.find({
      where: {customerId, isDeleted: false, status: OrderStatus.DELIVERED} as any,
      order: ['createdAt ASC'],
    });
    if (!orders.length) return {billableOrders: [], totalDue: 0};

    const orderIds = orders.map(o => o.id);
    const [individualInvoices, links] = await Promise.all([
      this.invoiceRepo.find({where: {orderId: {inq: orderIds}} as any}),
      this.invoiceOrderLinkRepo.find({where: {orderId: {inq: orderIds}} as any}),
    ]);
    const invoicedOrderIds = new Set([
      ...individualInvoices.map(i => i.orderId),
      ...links.map(l => l.orderId),
    ]);
    const billable = orders.filter(o => !invoicedOrderIds.has(o.id));
    if (!billable.length) return {billableOrders: [], totalDue: 0};

    const payments = await this.paymentRepo.find({
      where: {orderId: {inq: billable.map(o => o.id)}} as any,
    });
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      const amt = (p as any).transactionType === 'refund' ? 0 : money((p as any).amount);
      const oid = (p as any).orderId;
      paidByOrder.set(oid, money((paidByOrder.get(oid) ?? 0) + amt));
    }

    const enriched = billable
      .map(o => {
        const total = money((o as any).totalAmount);
        const paid = paidByOrder.get(o.id) ?? 0;
        const amountDue = Math.max(0, money(total - paid));
        return {
          orderId: o.id,
          orderNumber: (o as any).orderNumber,
          createdAt: o.createdAt,
          deliveryDate: (o as any).deliveryDate ?? null,
          totalAmount: total,
          amountPaid: paid,
          amountDue,
        };
      })
      // A delivered, un-invoiced order that's already fully paid needs no
      // billing at all — offering it here would let staff bundle it into a
      // consolidated invoice for ₹0 and permanently mark it "invoiced".
      .filter(o => o.amountDue > 0);

    return {billableOrders: enriched, totalDue: money(enriched.reduce((s, o) => s + o.amountDue, 0))};
  }

  // ─── On Account: Generate Consolidated Invoice ────────────────────────────
  // Bills several delivered orders as ONE invoice, not one per order — the
  // whole point of on-account billing. Amounts owed are summed as-is (each
  // order was already priced/taxed individually at creation); this doesn't
  // re-tax anything, it just totals up what's still due across the batch.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:update']})
  @post('/customers/{customerId}/on-account/generate-invoice')
  @response(200, {description: 'Consolidated invoice generated for the selected on-account orders'})
  async generateOnAccountInvoice(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['orderIds'],
            properties: {
              orderIds: {type: 'array', items: {type: 'string', format: 'uuid'}, minItems: 1},
            },
          },
        },
      },
    })
    body: {orderIds: string[]},
  ): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    if (customer.customerEntityType !== 'business' && !customer.isOnAccountEligible) {
      throw new HttpErrors.BadRequest('Consolidated invoicing is only for on-account eligible customers.');
    }

    const orderIds = [...new Set(body.orderIds ?? [])];
    if (!orderIds.length) throw new HttpErrors.BadRequest('Select at least one order to bill.');

    const orders = await this.orderRepo.find({
      where: {id: {inq: orderIds}, customerId, isDeleted: false} as any,
    });
    if (orders.length !== orderIds.length) {
      throw new HttpErrors.BadRequest('One or more orders were not found for this customer.');
    }
    const notDelivered = orders.filter(o => o.status !== OrderStatus.DELIVERED);
    if (notDelivered.length) {
      throw new HttpErrors.BadRequest(
        `Only delivered orders can be billed. Not delivered: ${notDelivered.map(o => (o as any).orderNumber).join(', ')}`,
      );
    }

    const [existingInvoices, existingLinks] = await Promise.all([
      this.invoiceRepo.find({where: {orderId: {inq: orderIds}} as any}),
      this.invoiceOrderLinkRepo.find({where: {orderId: {inq: orderIds}} as any}),
    ]);
    if (existingInvoices.length || existingLinks.length) {
      const already = new Set([
        ...existingInvoices.map(i => i.orderId),
        ...existingLinks.map(l => l.orderId),
      ]);
      throw new HttpErrors.BadRequest(
        `Already invoiced: ${orders.filter(o => already.has(o.id)).map(o => (o as any).orderNumber).join(', ')}`,
      );
    }

    const payments = await this.paymentRepo.find({where: {orderId: {inq: orderIds}} as any});
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      const amt = (p as any).transactionType === 'refund' ? 0 : money((p as any).amount);
      const oid = (p as any).orderId;
      paidByOrder.set(oid, money((paidByOrder.get(oid) ?? 0) + amt));
    }

    const orderTotals = orders.map(o => ({
      orderId: o.id,
      due: Math.max(0, money((o as any).totalAmount) - (paidByOrder.get(o.id) ?? 0)),
    }));
    // Reject individually, not just as a batch total — an already-fully-paid
    // order slipped in alongside genuinely unpaid ones would otherwise still
    // get an invoice_order_link row and be marked "invoiced" for ₹0.
    const alreadyPaid = orderTotals.filter(o => o.due <= 0);
    if (alreadyPaid.length) {
      const paidOrderNumbers = orders
        .filter(o => alreadyPaid.some(p => p.orderId === o.id))
        .map(o => (o as any).orderNumber)
        .join(', ');
      throw new HttpErrors.BadRequest(
        `Already fully paid, remove from selection: ${paidOrderNumbers}`,
      );
    }
    const combinedTotal = money(orderTotals.reduce((s, o) => s + o.due, 0));
    if (combinedTotal <= 0) {
      throw new HttpErrors.BadRequest('Selected orders have no outstanding balance to invoice.');
    }

    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.invoiceRepo.count();
    const invoiceNumber = `INV-${ym}-${String(count.count + 1).padStart(5, '0')}`;

    const {v4} = await import('uuid');
    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED'} as any);
    try {
      const invoice = await this.invoiceRepo.create(
        {
          id: v4(),
          orderId: orders[0].id, // representative order — full set is in invoice_order_link
          invoiceNumber,
          generatedBy: currentUser[securityId],
          isConsolidated: true,
          subtotal: combinedTotal,
          totalAmount: Math.round(combinedTotal),
          amountReceived: 0,
          balanceDue: Math.round(combinedTotal),
          status: InvoiceStatus.ISSUED,
        } as Partial<Invoice>,
        {transaction: tx},
      );

      for (const ot of orderTotals) {
        await this.invoiceOrderLinkRepo.create(
          {id: v4(), invoiceId: invoice.id, orderId: ot.orderId, orderTotal: parseFloat(ot.due.toFixed(2))},
          {transaction: tx},
        );
      }

      await tx.commit();
      return {message: 'Consolidated invoice generated.', invoice, orderCount: orderTotals.length};
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ─── On Account: Orders behind a Consolidated Invoice ─────────────────────
  // A consolidated invoice's own `orderId` only names one representative
  // order (see generateOnAccountInvoice) — this is how the frontend finds
  // every order it actually covers, to print/view a full itemized breakdown
  // across all of them (via printCombinedThermalReceipt).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:read']})
  @get('/invoices/{invoiceId}/consolidated-orders')
  @response(200, {description: 'Orders linked to a consolidated on-account invoice'})
  async consolidatedInvoiceOrders(
    @param.path.string('invoiceId') invoiceId: string,
  ): Promise<object> {
    const invoice = await this.invoiceRepo.findById(invoiceId);
    if (!invoice) throw new HttpErrors.NotFound('Invoice not found.');

    const links = await this.invoiceOrderLinkRepo.find({where: {invoiceId} as any});
    const orderIds = links.length ? links.map(l => l.orderId) : [invoice.orderId];
    const orders = await this.orderRepo.find({where: {id: {inq: orderIds}} as any});

    return {
      invoice,
      orders: orders.map(o => ({orderId: o.id, orderNumber: (o as any).orderNumber})),
    };
  }

  // ─── On Account: Invoice History ───────────────────────────────────────────
  // All consolidated invoices for the customer, paid or not — the pending-
  // invoices list only surfaces ones with balanceDue > 0, so a fully-paid
  // consolidated invoice would otherwise have no way to be looked up again.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:read']})
  @get('/customers/{customerId}/on-account/invoices')
  @response(200, {description: 'All consolidated on-account invoices for the customer, most recent first'})
  async onAccountInvoiceHistory(@param.path.string('customerId') customerId: string): Promise<object> {
    const customer = await this.customerRepo.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const orders = await this.orderRepo.find({where: {customerId, isDeleted: false} as any});
    const orderIds = orders.map(o => o.id);
    if (!orderIds.length) return {invoices: []};

    const invoices = await this.invoiceRepo.find({
      where: {orderId: {inq: orderIds}, isConsolidated: true} as any,
      order: ['createdAt DESC'],
    });

    return {
      invoices: invoices.map(inv => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        totalAmount: money(inv.totalAmount),
        amountReceived: money(inv.amountReceived),
        balanceDue: money(inv.balanceDue),
        status: inv.status,
        createdAt: inv.createdAt,
      })),
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
