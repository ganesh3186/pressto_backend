import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Count, repository, Where} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ChallanStatus} from '../models/challan.model';
import {OrderStatus} from '../models/order-status.enum';
import {Invoice, InvoiceStatus} from '../models/invoice.model';
import {
  ChallanRepository,
  CustomerRepository,
  InvoiceOrderLinkRepository,
  InvoiceRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  UsersRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

export class InvoiceController {
  constructor(
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @repository(InvoiceOrderLinkRepository) private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── List Invoices ────────────────────────────────────────────────────────
  // Real Invoice rows — not orders. A regular invoice covers exactly one
  // order (orderId); a consolidated (isConsolidated) invoice covers several,
  // linked via InvoiceOrderLink, with orderId kept as just the representative
  // one (see the Invoice model's own comment on that field).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/invoices')
  @response(200, {description: 'Array of Invoice records, enriched with order/customer summary'})
  async find(
    @param.query.string('search') search?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
    @param.query.string('status') status?: string,
    @param.query.string('type') type?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object[]> {
    const where = await this._buildInvoiceWhere({search, status, type, dateFrom, dateTo});
    const invoices = await this.invoiceRepo.find({
      where,
      order: ['createdAt DESC'],
      ...(limit !== undefined ? {limit} : {}),
      ...(skip !== undefined ? {skip} : {}),
    });
    return this._enrichInvoices(invoices);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/invoices/count')
  @response(200, {description: 'Count of Invoice records matching the same filters as find()'})
  async count(
    @param.query.string('search') search?: string,
    @param.query.string('status') status?: string,
    @param.query.string('type') type?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<Count> {
    const where = await this._buildInvoiceWhere({search, status, type, dateFrom, dateTo});
    return this.invoiceRepo.count(where);
  }

  /**
   * Shared where-builder for find()/count() — the list and its count must
   * always agree on which rows match, or the pagination UI's total would
   * disagree with what's actually shown.
   */
  private async _buildInvoiceWhere(params: {
    search?: string;
    status?: string;
    type?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Where<Invoice>> {
    const clauses: object[] = [];

    if (params.status) {
      clauses.push({status: params.status});
    }
    if (params.dateFrom || params.dateTo) {
      const range: Record<string, string> = {};
      if (params.dateFrom) range.gte = params.dateFrom;
      if (params.dateTo) range.lte = params.dateTo;
      clauses.push({createdAt: range});
    }

    if (params.type === 'onAccount' || params.type === 'regular') {
      const onAccountOrderIds = await this._onAccountOrderIds();
      // Empty on no match — correctly yields zero rows for 'onAccount'
      // rather than accidentally matching everything.
      clauses.push(
        params.type === 'onAccount'
          ? {orderId: {inq: onAccountOrderIds}}
          : {orderId: {nin: onAccountOrderIds}},
      );
    }

    if (params.search?.trim()) {
      const q = params.search.trim();
      const digits = q.replace(/\D/g, '');
      const [orderIdsByCustomer, orderIdsByNumber] = await Promise.all([
        this._orderIdsMatchingCustomer(q, digits),
        this._orderIdsMatchingNumber(q),
      ]);
      const orderIdsBySearch = [...new Set([...orderIdsByCustomer, ...orderIdsByNumber])];
      const orClauses: object[] = [{invoiceNumber: {ilike: `%${q}%`}}];
      if (orderIdsBySearch.length) {
        orClauses.push({orderId: {inq: orderIdsBySearch}});
      }
      clauses.push({or: orClauses});
    }

    return (clauses.length ? {and: clauses} : {}) as Where<Invoice>;
  }

  /** Order ids belonging to an on-account-eligible customer (business, or opted in). */
  private async _onAccountOrderIds(): Promise<string[]> {
    const onAccountCustomers = await this.customerRepo.find({
      where: {or: [{customerEntityType: 'business'}, {isOnAccountEligible: true}]},
      fields: {id: true},
    });
    if (!onAccountCustomers.length) return [];
    const orders = await this.orderRepo.find({
      where: {customerId: {inq: onAccountCustomers.map(c => c.id)}},
      fields: {id: true},
    });
    return orders.map(o => o.id);
  }

  /** Order ids whose customer's name or phone matches the search term. */
  private async _orderIdsMatchingCustomer(query: string, digits: string): Promise<string[]> {
    const customerWhere: object[] = [
      {firstName: {ilike: `%${query}%`}},
      {lastName: {ilike: `%${query}%`}},
    ];
    // Phone lives on Users, not Customer — resolve matching Users rows
    // first, then fold their ids into the same OR. Require a few digits so
    // a 1-2 digit search doesn't turn into an accidental "match everyone" scan.
    if (digits.length >= 3) {
      const matchedUsers = await this.usersRepo.find({
        where: {phone: {like: `%${digits}%`}},
        fields: {id: true},
      });
      if (matchedUsers.length) {
        customerWhere.push({userId: {inq: matchedUsers.map(u => u.id)}});
      }
    }
    const customers = await this.customerRepo.find({
      where: {or: customerWhere},
      fields: {id: true},
    });
    if (!customers.length) return [];
    const orders = await this.orderRepo.find({
      where: {customerId: {inq: customers.map(c => c.id)}},
      fields: {id: true},
    });
    return orders.map(o => o.id);
  }

  /** Order ids whose own order number matches the search term (Transaction ID field). */
  private async _orderIdsMatchingNumber(query: string): Promise<string[]> {
    const orders = await this.orderRepo.find({
      where: {orderNumber: {ilike: `%${query}%`}},
      fields: {id: true},
    });
    return orders.map(o => o.id);
  }

  /** Attach orderNumber/customer summary/type/orderCount to a page of invoices. */
  private async _enrichInvoices(invoices: Invoice[]): Promise<object[]> {
    if (!invoices.length) return [];

    const orderIds = [...new Set(invoices.map(inv => inv.orderId).filter(Boolean))];
    const orders = await this.orderRepo.find({
      where: {id: {inq: orderIds}},
      fields: {id: true, orderNumber: true, customerId: true},
    });
    const orderById = new Map(orders.map(o => [o.id, o]));

    const customerIds = [...new Set(orders.map(o => o.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await this.customerRepo.find({
          where: {id: {inq: customerIds}},
          fields: {
            id: true,
            firstName: true,
            lastName: true,
            userId: true,
            customerEntityType: true,
            isOnAccountEligible: true,
          },
        })
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    const userIds = [...new Set(customers.map(c => c.userId).filter(Boolean))];
    const users = userIds.length
      ? await this.usersRepo.find({where: {id: {inq: userIds}}, fields: {id: true, phone: true}})
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    const consolidatedIds = invoices.filter(inv => inv.isConsolidated).map(inv => inv.id);
    const orderCountByInvoiceId = new Map<string, number>();
    if (consolidatedIds.length) {
      const links = await this.invoiceOrderLinkRepo.find({
        where: {invoiceId: {inq: consolidatedIds}},
        fields: {invoiceId: true},
      });
      for (const link of links) {
        orderCountByInvoiceId.set(link.invoiceId, (orderCountByInvoiceId.get(link.invoiceId) ?? 0) + 1);
      }
    }

    return invoices.map(inv => {
      const order = orderById.get(inv.orderId);
      const customer = order ? customerById.get(order.customerId) : undefined;
      const user = customer?.userId ? userById.get(customer.userId) : undefined;
      const isOnAccount =
        customer?.customerEntityType === 'business' || customer?.isOnAccountEligible === true;

      return {
        ...inv,
        orderNumber: order?.orderNumber ?? null,
        customer: {
          id: customer?.id ?? null,
          name: customer ? `${customer.firstName} ${customer.lastName}`.trim() : null,
          phone: user?.phone ?? null,
        },
        type: isOnAccount ? 'onAccount' : 'regular',
        orderCount: inv.isConsolidated ? orderCountByInvoiceId.get(inv.id) ?? 1 : 1,
      };
    });
  }

  // ─── Generate Invoice ─────────────────────────────────────────────────────
  // Converts the order's challan into a final invoice.
  // Takes a snapshot of the current order items (may differ from challan
  // if upgrades / returns happened after challan was issued).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/invoice/generate')
  @response(200, {description: 'Invoice generated'})
  async generate(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const ALLOWED_STATUSES = [
      OrderStatus.READY,
      OrderStatus.PARTIALLY_DISPATCHED,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ];
    if (!ALLOWED_STATUSES.includes(order.status as OrderStatus)) {
      throw new HttpErrors.BadRequest('Invoice can only be generated after processing and quality checks are complete (status must be ready or beyond).');
    }

    // Guard: only one invoice per order
    const existingInvoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (existingInvoice) {
      return {message: 'Invoice already exists for this order.', invoice: existingInvoice};
    }

    // Snapshot current order items
    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const items = orderItems.map(oi => ({
      orderItemId: oi.id,
      serviceId: oi.serviceId,
      itemId: oi.itemId,
      quantity: Number(oi.quantity) || 0,
      // Postgres numeric columns come back as strings — coerce so downstream
      // math sums numerically instead of concatenating.
      unitPrice: Number(oi.unitPrice) || 0,
      totalPrice: Number(oi.totalPrice) || 0,
      additionalServiceIds: oi.additionalServiceIds ?? [],
      // Shown on the invoice as a ₹0 "Rejected at intake" line for the record.
      rejectedAtIntake: oi.rejectedAtIntake ?? false,
      rejectionReason: oi.rejectionReason ?? null,
    }));

    const subtotal = items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0);
    const gstRate = 0.09;
    const cgst = parseFloat((subtotal * gstRate).toFixed(2));
    const sgst = parseFloat((subtotal * gstRate).toFixed(2));
    const discount = Number(order.discountAmount) || 0;
    // Final total is a whole rupee (≥ .5 rounds up); components keep decimals.
    const totalAmount = Math.round(subtotal - discount + cgst + sgst);

    // Sum all payment transactions for this order
    const payments = await this.paymentRepo.find({where: {orderId}} as any);
    const amountReceived = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const balanceDue = parseFloat(Math.max(0, totalAmount - amountReceived).toFixed(2));

    // Generate invoice number: INV-YYYYMM-00001
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.invoiceRepo.count();
    const invoiceNumber = `INV-${ym}-${String(count.count + 1).padStart(5, '0')}`;

    const {v4} = await import('uuid');

    // Find the challan to link and mark it converted
    const challan = await this.challanRepo.findOne({where: {orderId}} as any);
    if (challan) {
      await this.challanRepo.updateById(challan.id, {status: ChallanStatus.CONVERTED_TO_INVOICE});
    }

    const invoice = await this.invoiceRepo.create({
      id: v4(),
      orderId,
      challanId: challan?.id,
      invoiceNumber,
      generatedBy: currentUser[securityId],
      items,
      subtotal: parseFloat(Number(subtotal).toFixed(2)),
      discount,
      deliveryCharge: 0,
      cgst,
      sgst,
      totalAmount,
      amountReceived: parseFloat(amountReceived.toFixed(2)),
      balanceDue,
      status: InvoiceStatus.ISSUED,
    } as Partial<Invoice>);

    return {message: 'Invoice generated.', invoice};
  }

  // ─── Get Invoice ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/invoice')
  @response(200, {description: 'Invoice for an order'})
  async getByOrder(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (!invoice) throw new HttpErrors.NotFound('No invoice found for this order.');

    return {invoice};
  }

  // ─── Mark Printed ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{orderId}/invoice/print')
  @response(200, {description: 'Invoice marked as printed'})
  async markPrinted(@param.path.string('orderId') orderId: string): Promise<object> {
    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (!invoice) throw new HttpErrors.NotFound('No invoice found for this order.');

    await this.invoiceRepo.updateById(invoice.id, {
      isPrinted: true,
      printedAt: new Date(),
    } as Partial<Invoice>);

    return {message: 'Invoice marked as printed.'};
  }
}
