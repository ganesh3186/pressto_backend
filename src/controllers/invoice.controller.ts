import {PresstoDataSource} from '../datasources';
import {OrderService} from '../services/order.service';
import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Count, repository, Where} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ChallanStatus} from '../models/challan.model';
import {OrderStatus} from '../models/order-status.enum';
import {Invoice, InvoiceStatus} from '../models/invoice.model';
import {SalesReturnStatus} from '../models/sales-return.model';
import {
  ChallanRepository,
  CustomerRepository,
  InvoiceOrderLinkRepository,
  InvoiceRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  SalesReturnRepository,
  UsersRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

type InvoiceListScope = {storeIds: string[]; extraOrderIds: string[]};
/** A raw filter on `public.invoice i`, with `?` placeholders. */
type InvoiceSqlCondition = {sql: string; params: unknown[]};
type InvoiceListFilter = {
  where: Where<Invoice>;
  conditions: InvoiceSqlCondition[];
  isSearch: boolean;
};

/** Most matches an invoice list search will count (see _countInvoicesBySql). */
const INVOICE_SEARCH_COUNT_CAP = 1000;
/** Above this many matching orders a search is "broad" (see _invoiceSearchCondition). */
const INVOICE_SEARCH_ORDER_LIST_CAP = 50000;
/** Above this many matching customers a 1-2 character term is "broad" (see _invoiceSearchCondition). */
const INVOICE_SEARCH_SHORT_TERM_CUSTOMER_CAP = 5000;

export class InvoiceController {
  constructor(
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(PaymentTransactionRepository)
    private paymentRepo: PaymentTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @repository(InvoiceOrderLinkRepository)
    private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @repository(SalesReturnRepository)
    private salesReturnRepo: SalesReturnRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
    @inject('services.order') private orderService: OrderService,
  ) {}

  private async creditTotals(invoiceIds: string[]) {
    const notes = await this.salesReturnRepo.find({
      where: {invoiceId: {inq: invoiceIds}, status: SalesReturnStatus.APPROVED},
    });
    const totals = new Map<string, number>();
    for (const note of notes) {
      if (
        !(note.returnedItems ?? []).some(line =>
          Boolean(
            (line as {invoiceBasis?: unknown}).invoiceBasis ??
            (line as {preservesInvoice?: boolean}).preservesInvoice,
          ),
        )
      )
        continue;
      const id = note.invoiceId!;
      totals.set(id, (totals.get(id) ?? 0) + Number(note.creditAmount ?? 0));
    }
    return totals;
  }

  // ─── List Invoices ────────────────────────────────────────────────────────
  // Real Invoice rows — not orders. A regular invoice covers exactly one
  // order (orderId); a consolidated (isConsolidated) invoice covers several,
  // linked via InvoiceOrderLink, with orderId kept as just the representative
  // one (see the Invoice model's own comment on that field).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/invoices')
  @response(200, {
    description:
      'Array of Invoice records, enriched with order/customer summary',
  })
  async find(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('search') search?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
    @param.query.string('status') status?: string,
    @param.query.string('type') type?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object[]> {
    const scope = await this._invoiceListScope(currentUser);
    if (scope && !scope.storeIds.length) return [];
    const filter = await this._buildInvoiceFilter({
      search,
      status,
      type,
      dateFrom,
      dateTo,
    });
    const invoices =
      scope !== null || filter.conditions.length > 0
        ? await this._findInvoicesBySql(filter, scope, limit, skip)
        : await this.invoiceRepo.find({
            where: filter.where,
            order: ['createdAt DESC'],
            ...(limit !== undefined ? {limit} : {}),
            ...(skip !== undefined ? {skip} : {}),
          });
    return this._enrichInvoices(invoices);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/invoices/count')
  @response(200, {
    description: 'Count of Invoice records matching the same filters as find()',
  })
  async count(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('search') search?: string,
    @param.query.string('status') status?: string,
    @param.query.string('type') type?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<Count> {
    const scope = await this._invoiceListScope(currentUser);
    if (scope && !scope.storeIds.length) return {count: 0};
    const filter = await this._buildInvoiceFilter({
      search,
      status,
      type,
      dateFrom,
      dateTo,
    });
    return scope !== null || filter.conditions.length > 0
      ? this._countInvoicesBySql(filter, scope)
      : this.invoiceRepo.count(filter.where);
  }

  /**
   * Which orders' invoices this caller may list, or null for an all-stores
   * caller. Same access as assertOrderVisible: the caller's stores, plus orders
   * with a garment at one of those stores through an active transfer.
   *
   * A consolidated invoice can span stores but names one representative order,
   * so it is in scope through that order when any of its linked orders is. An
   * order on a consolidated invoice can't have another invoice (see
   * generateOnAccountInvoice), so this exposes nothing else.
   */
  private async _invoiceListScope(
    currentUser: UserProfile,
  ): Promise<InvoiceListScope | null> {
    const scope = await this.storeScopeService.resolve(currentUser);
    if (scope.global) return null;
    if (!scope.storeIds.length) return {storeIds: [], extraOrderIds: []};

    const transferOrderIds = await this.storeScopeService.transferGrantedOrderIds(
      scope.storeIds,
    );
    const consolidated: {orderid: string}[] = await this.dataSource.execute(
      `SELECT DISTINCT i.orderid
         FROM public.invoice i
         JOIN public.invoice_order_link l ON l.invoiceid = i.id
         JOIN public.orders o ON o.id = l.orderid
        WHERE i.isconsolidated = true
          AND (o.storeid = ANY($1) OR o.id = ANY($2))`,
      [scope.storeIds, transferOrderIds],
    );
    return {
      storeIds: scope.storeIds,
      extraOrderIds: [
        ...new Set([
          ...transferOrderIds,
          ...consolidated.map(row => row.orderid),
        ]),
      ],
    };
  }

  /**
   * FROM/WHERE for the invoices matching a filter and, unless the caller sees
   * all stores (scope null), the caller's scope. Invoices have no storeId and
   * reach a store only through their order, and one store can have more orders
   * than fit in a Node-built IN list, so the match runs inside SQL. Kept as one
   * IN subquery so Postgres can pick the invoiceCreatedAt index for a busy store
   * or the order's store index for a quiet one.
   */
  private _invoiceQuery(
    filter: InvoiceListFilter,
    scope: InvoiceListScope | null,
  ): {fromSql: string; params: unknown[]} {
    const base = this._connector().buildWhere(
      this.invoiceRepo.entityClass.modelName,
      filter.where,
    );
    const conditions = [
      ...(base.sql ? [`(${base.sql.replace(/^WHERE /, '')})`] : []),
      ...filter.conditions.map(condition => condition.sql),
      ...(scope
        ? [
            'i.orderid IN (SELECT o.id FROM public.orders o' +
              ' WHERE o.storeid = ANY(?) OR o.id = ANY(?))',
          ]
        : []),
    ];
    return {
      fromSql:
        'FROM public.invoice i' +
        (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''),
      params: [
        ...base.params,
        ...filter.conditions.flatMap(condition => condition.params),
        ...(scope ? [scope.storeIds, scope.extraOrderIds] : []),
      ],
    };
  }

  /** One page of find(), for a store-limited caller or a search/type filter. */
  private async _findInvoicesBySql(
    filter: InvoiceListFilter,
    scope: InvoiceListScope | null,
    limit?: number,
    skip?: number,
  ): Promise<Invoice[]> {
    const {fromSql, params} = this._invoiceQuery(filter, scope);
    const page = this._connector().parameterize({
      sql:
        `SELECT i.id ${fromSql} ORDER BY i.createdat DESC, i.id DESC` +
        (limit !== undefined ? ' LIMIT ?' : '') +
        (skip !== undefined ? ' OFFSET ?' : ''),
      params: [
        ...params,
        ...(limit !== undefined ? [limit] : []),
        ...(skip !== undefined ? [skip] : []),
      ],
    });
    const rows: {id: string}[] = await this.dataSource.execute(
      page.sql,
      page.params,
    );
    const ids = rows.map(row => row.id);
    if (!ids.length) return [];
    const found = await this.invoiceRepo.find({where: {id: {inq: ids}}});
    const byId = new Map(found.map(invoice => [invoice.id, invoice]));
    return ids
      .map(id => byId.get(id))
      .filter((invoice): invoice is Invoice => Boolean(invoice));
  }

  /**
   * count() matching _findInvoicesBySql. Counting every match of a broad search
   * means visiting most of the table, so a search counts only up to
   * INVOICE_SEARCH_COUNT_CAP. A specific search still gets its exact count.
   */
  private async _countInvoicesBySql(
    filter: InvoiceListFilter,
    scope: InvoiceListScope | null,
  ): Promise<Count> {
    const {fromSql, params} = this._invoiceQuery(filter, scope);
    const query = this._connector().parameterize(
      filter.isSearch
        ? {
            sql: `SELECT count(*)::int AS count FROM (SELECT 1 ${fromSql} LIMIT ?) matches`,
            params: [...params, INVOICE_SEARCH_COUNT_CAP],
          }
        : {sql: `SELECT count(*)::int AS count ${fromSql}`, params},
    );
    const rows: {count: number}[] = await this.dataSource.execute(
      query.sql,
      query.params,
    );
    return {count: Number(rows[0]?.count ?? 0)};
  }

  private _connector() {
    return this.dataSource.connector as unknown as {
      buildWhere(model: string, where: object): {sql: string; params: unknown[]};
      parameterize(ps: {sql: string; params: unknown[]}): {
        sql: string;
        params: unknown[];
      };
    };
  }

  /**
   * Shared filter-builder for find()/count() — the list and its count must
   * always agree on which rows match, or the pagination UI's total would
   * disagree with what's actually shown.
   */
  private async _buildInvoiceFilter(params: {
    search?: string;
    status?: string;
    type?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<InvoiceListFilter> {
    const clauses: object[] = [];
    const conditions: InvoiceSqlCondition[] = [];

    if (params.status) {
      clauses.push({status: params.status});
    }
    if (params.dateFrom || params.dateTo) {
      const range: Record<string, string> = {};
      if (params.dateFrom) range.gte = params.dateFrom;
      if (params.dateTo) range.lte = params.dateTo;
      if (range.gte) clauses.push({createdAt: {gte: range.gte}});
      if (range.lte) clauses.push({createdAt: {lte: range.lte}});
    }

    if (params.type === 'onAccount' || params.type === 'regular') {
      conditions.push(this._invoiceTypeCondition(params.type));
    }

    const q = params.search?.trim();
    if (q) conditions.push(await this._invoiceSearchCondition(q));

    return {
      where: (clauses.length ? {and: clauses} : {}) as Where<Invoice>,
      conditions,
      isSearch: Boolean(q),
    };
  }

  /**
   * Whether the invoice's order belongs to an on-account-eligible customer
   * (business, or opted in). Runs inside SQL because these orders used to be
   * loaded into Node and sent back as one oversized IN list.
   */
  private _invoiceTypeCondition(
    type: 'onAccount' | 'regular',
  ): InvoiceSqlCondition {
    const onAccount =
      'EXISTS (SELECT 1 FROM public.orders o' +
      ' JOIN public.customer c ON c.id = o.customerid' +
      ' WHERE o.id = i.orderid' +
      " AND (c.customerentitytype = 'business' OR c.isonaccounteligible = true))";
    return {sql: type === 'onAccount' ? onAccount : `NOT ${onAccount}`, params: []};
  }

  /**
   * Free-text search: invoice number, order number (Transaction ID field),
   * customer name, or the customer's login phone. These matches used to be
   * resolved into a Node-built IN list, which failed with an oversized `bind
   * message` on a broad term.
   *
   * Specific terms match few orders: resolve them through the trigram indexes
   * and pass them as ONE array parameter, so invoices are found via their
   * orderid index. Broad terms ("m", "2") match too many for that, so fall back
   * to a per-invoice EXISTS, which stops as soon as the page is filled because
   * matches are dense. A common surname fits the array path: at 44K matching
   * orders it took 4 ms a page, against 1.7 s for the EXISTS.
   *
   * A 1-2 character term can't use the trigram indexes, so looking up its orders
   * scans orders and customers (about 3 s). If it matches many customers it is
   * broad, so skip that. A rare one ("qz") must still do it: the EXISTS would
   * walk all 2M invoices to fill a page (over 25 s, measured on migration).
   */
  private async _invoiceSearchCondition(
    q: string,
  ): Promise<InvoiceSqlCondition> {
    const like = `%${q}%`;
    // Phone lives on Users, not Customer. Require a few digits so a 1-2 digit
    // search doesn't turn into an accidental "match everyone" scan.
    const digits = q.replace(/\D/g, '');
    const phoneLike = digits.length >= 3 ? `%${digits}%` : null;

    const isBroadShortTerm =
      q.length < 3 && (await this._manyCustomersMatch(like));
    if (!isBroadShortTerm) {
      // UNION ALL, not UNION, so a broad term stops at the LIMIT instead of
      // first collecting every match to remove duplicates.
      const orderRows: {id: string}[] = await this.dataSource.execute(
        `SELECT o.id FROM public.orders o WHERE o.ordernumber ILIKE $1
         UNION ALL
         SELECT o.id FROM public.customer c JOIN public.orders o ON o.customerid = c.id
          WHERE c.firstname ILIKE $1 OR c.lastname ILIKE $1
         ${
           phoneLike
             ? `UNION ALL
         SELECT o.id FROM public.users u
           JOIN public.customer c ON c.userid = u.id::text
           JOIN public.orders o ON o.customerid = c.id
          WHERE u.phone LIKE $2`
             : ''
         }
         LIMIT ${INVOICE_SEARCH_ORDER_LIST_CAP + 1}`,
        phoneLike ? [like, phoneLike] : [like],
      );
      if (orderRows.length <= INVOICE_SEARCH_ORDER_LIST_CAP) {
        return {
          sql: '(i.invoicenumber ILIKE ? OR i.orderid = ANY(?::uuid[]))',
          params: [like, [...new Set(orderRows.map(row => row.id))]],
        };
      }
    }
    return {
      sql:
        '(i.invoicenumber ILIKE ? OR EXISTS (SELECT 1 FROM public.orders o' +
        ' LEFT JOIN public.customer c ON c.id = o.customerid' +
        (phoneLike ? ' LEFT JOIN public.users u ON u.id = c.userid::uuid' : '') +
        ' WHERE o.id = i.orderid AND (o.ordernumber ILIKE ?' +
        ' OR c.firstname ILIKE ? OR c.lastname ILIKE ?' +
        (phoneLike ? ' OR u.phone LIKE ?' : '') +
        ')))',
      params: [like, like, like, like, ...(phoneLike ? [phoneLike] : [])],
    };
  }

  /** Whether a customer-name pattern matches more than the short-term cap. */
  private async _manyCustomersMatch(like: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.execute(
      `SELECT 1 FROM public.customer c
        WHERE c.firstname ILIKE $1 OR c.lastname ILIKE $1
        LIMIT ${INVOICE_SEARCH_SHORT_TERM_CUSTOMER_CAP + 1}`,
      [like],
    );
    return rows.length > INVOICE_SEARCH_SHORT_TERM_CUSTOMER_CAP;
  }

  /** Attach orderNumber/customer summary/type/orderCount to a page of invoices. */
  private async _enrichInvoices(invoices: Invoice[]): Promise<object[]> {
    if (!invoices.length) return [];
    const creditTotals = await this.creditTotals(
      invoices.map(invoice => invoice.id),
    );

    const orderIds = [
      ...new Set(invoices.map(inv => inv.orderId).filter(Boolean)),
    ];
    const orders = await this.orderRepo.find({
      where: {id: {inq: orderIds}},
      fields: {id: true, orderNumber: true, customerId: true, status: true},
    });
    const orderById = new Map(orders.map(o => [o.id, o]));

    const customerIds = [
      ...new Set(orders.map(o => o.customerId).filter(Boolean)),
    ];
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
      ? await this.usersRepo.find({
          where: {id: {inq: userIds}},
          fields: {id: true, phone: true},
        })
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    const consolidatedIds = invoices
      .filter(inv => inv.isConsolidated)
      .map(inv => inv.id);
    const orderCountByInvoiceId = new Map<string, number>();
    if (consolidatedIds.length) {
      const links = await this.invoiceOrderLinkRepo.find({
        where: {invoiceId: {inq: consolidatedIds}},
        fields: {invoiceId: true},
      });
      for (const link of links) {
        orderCountByInvoiceId.set(
          link.invoiceId,
          (orderCountByInvoiceId.get(link.invoiceId) ?? 0) + 1,
        );
      }
    }

    return invoices.map(inv => {
      const order = orderById.get(inv.orderId);
      const customer = order ? customerById.get(order.customerId) : undefined;
      const user = customer?.userId ? userById.get(customer.userId) : undefined;
      const isOnAccount =
        customer?.customerEntityType === 'business' ||
        customer?.isOnAccountEligible === true;

      return {
        ...inv,
        creditNotesTotal: creditTotals.get(inv.id) ?? 0,
        netPayable: Math.max(
          0,
          Number(inv.totalAmount ?? 0) - (creditTotals.get(inv.id) ?? 0),
        ),
        orderNumber: order?.orderNumber ?? null,
        orderStatus: order?.status ?? null,
        customer: {
          id: customer?.id ?? null,
          name: customer
            ? `${customer.firstName} ${customer.lastName}`.trim()
            : null,
          phone: user?.phone ?? null,
        },
        type: isOnAccount ? 'onAccount' : 'regular',
        orderCount: inv.isConsolidated
          ? (orderCountByInvoiceId.get(inv.id) ?? 1)
          : 1,
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
    await this.storeScopeService.assertOrderVisible(orderId, currentUser);
    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED',
    });
    const options = {transaction: tx};
    try {
      await this.dataSource.execute(
        'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
        [orderId],
        options,
      );
      const order = await this.orderRepo.findOne(
        {
          where: {id: orderId, isDeleted: false},
        },
        options,
      );
      if (!order) throw new HttpErrors.NotFound('Order not found.');

      // On-account orders are billed only through a consolidated on-account
      // invoice (see CustomerBillingController) — an individual one would bill
      // the same order twice.
      if (order.isOnAccount) {
        throw new HttpErrors.BadRequest(
          'On-account orders are billed on a consolidated on-account invoice, not an individual invoice.',
        );
      }

      const ALLOWED_STATUSES = [
        OrderStatus.READY,
        OrderStatus.PARTIALLY_DISPATCHED,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
      ];
      if (!ALLOWED_STATUSES.includes(order.status as OrderStatus)) {
        throw new HttpErrors.BadRequest(
          'Invoice can only be generated after processing and quality checks are complete (status must be ready or beyond).',
        );
      }

      // Guard: only one invoice per order
      const existingInvoice = await this.invoiceRepo.findOne(
        {
          where: {orderId},
        } as any,
        options,
      );
      if (existingInvoice) {
        await tx.commit();
        return {
          message: 'Invoice already exists for this order.',
          invoice: existingInvoice,
        };
      }

      // Snapshot current order items
      const orderItems = await this.orderItemRepo.find(
        {where: {orderId}},
        options,
      );
      const printableItems = new Map(((await this.orderService.getOrderDetails(orderId, options)) as {
        items?: Array<{id: string; itemName?: string; serviceName?: string;
          isMeasurement?: boolean; garments?: object[]}>;
      }).items?.map(item => [item.id, item]) ?? []);
      const items = orderItems.map(oi => ({
        ...printableItems.get(oi.id),
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

      const subtotal = parseFloat(
        items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0).toFixed(2),
      );
      const gstRate = 0.09;
      const discount = Math.min(Number(order.discountAmount) || 0, subtotal);
      const taxableSubtotal = Math.max(0, subtotal - discount);
      const cgst = parseFloat((taxableSubtotal * gstRate).toFixed(2));
      const sgst = parseFloat((taxableSubtotal * gstRate).toFixed(2));
      // Final total is a whole rupee (≥ .5 rounds up); components keep decimals.
      const totalAmount = Math.round(subtotal - discount + cgst + sgst);

      // Refund transactions are outgoing money, not amount received.
      const payments = await this.paymentRepo.find(
        {where: {orderId}} as any,
        options,
      );
      const amountReceived = payments.reduce(
        (s: number, p: any) =>
          s + (p.transactionType === 'refund' ? 0 : Number(p.amount) || 0),
        0,
      );
      const balanceDue = parseFloat(
        Math.max(0, totalAmount - amountReceived).toFixed(2),
      );

      const invoiceNumber = await this.orderService.allocateInvoiceNumber(
        tx,
        order.storeId,
      );

      const {v4} = await import('uuid');

      // Find the challan to link and mark it converted
      const challan = await this.challanRepo.findOne(
        {where: {orderId}} as any,
        options,
      );
      if (challan) {
        await this.challanRepo.updateById(
          challan.id,
          {
            status: ChallanStatus.CONVERTED_TO_INVOICE,
          },
          options,
        );
      }

      const invoice = await this.invoiceRepo.create(
        {
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
        } as Partial<Invoice>,
        options,
      );

      await tx.commit();
      return {message: 'Invoice generated.', invoice};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
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

    const order = await this.orderRepo.findOne({
      where: {id: orderId, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const invoice = await this.orderService.syncInvoiceTotalsForOrder(order);
    if (!invoice) throw new HttpErrors.NotFound('No invoice found for this order.');

    const credits =
      (await this.creditTotals([invoice.id])).get(invoice.id) ?? 0;
    return {
      invoice: {
        ...invoice,
        creditNotesTotal: credits,
        netPayable: Math.max(0, Number(invoice.totalAmount ?? 0) - credits),
      },
    };
  }

  // ─── Mark Printed ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{orderId}/invoice/print')
  @response(200, {description: 'Invoice marked as printed'})
  async markPrinted(
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (!invoice)
      throw new HttpErrors.NotFound('No invoice found for this order.');

    await this.invoiceRepo.updateById(invoice.id, {
      isPrinted: true,
      printedAt: new Date(),
    } as Partial<Invoice>);

    return {message: 'Invoice marked as printed.'};
  }
}
