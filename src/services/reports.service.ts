import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {ShiftStatus} from '../models/shift-status.enum';
import {
  ClusterRepository,
  CustomerLabelAssignmentRepository,
  CustomerLabelRepository,
  CustomerRepository,
  DeliveryOrderRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  PettyCashRegisterEntryRepository,
  RegionRepository,
  ShiftRepository,
  StoreRepository,
} from '../repositories';

/** Fixed business-unit label; the schema carries no BU dimension yet. */
const BUSINESS_UNIT = 'Pressto';

/**
 * Order types that originate as a home pickup — the "P2D" filter on the
 * ticket/payment reports.
 *
 * There is no equivalent for "PMU": nothing in the schema records it, so
 * that filter matches nothing rather than silently behaving like P2D.
 */
const P2D_ORDER_TYPES = [OrderType.HOME_PICKUP, OrderType.HOME_PICKUP_HOME_DELIVERY];

/** Statuses that take an order out of the pending-tickets report. */
const TICKET_TERMINAL_STATUSES = [
  OrderStatus.CANCELLED,
  OrderStatus.DRAFT,
  OrderStatus.DELIVERED,
];

/** Human label per payment mode, so every client renders these identically. */
const PAYMENT_MODE_LABELS: Record<string, string> = {
  [PaymentMode.CASH]: 'Cash',
  [PaymentMode.CARD]: 'Card',
  [PaymentMode.UPI]: 'UPI',
  [PaymentMode.NET_BANKING]: 'Net Banking',
  [PaymentMode.BANK_TRANSFER]: 'Bank Transfer',
  [PaymentMode.CHEQUE]: 'Cheque',
  [PaymentMode.PDC]: 'PDC',
  [PaymentMode.PAY_LATER]: 'Pay Later',
  [PaymentMode.ON_ACCOUNT]: 'On Account',
  [PaymentMode.GATEWAY]: 'Gateway',
  [PaymentMode.WALLET]: 'Wallet',
};

export type ModeOfPaymentRow = {
  id: string;
  storeName: string;
  date: Date | null;
  shiftClosureNo: string;
  ticketNo: string;
  userName: string;
  amount: number;
  reimbursement: number;
  paymentMode: string;
  paymentModeLabel: string;
};

type CustomerContext = {name: string; code: string; groupName: string; groupId: string};

/** Filters common to every order-backed report. */
export type OrderReportParams = {
  storeIds: string[];
  from: Date;
  to: Date;
  limit: number;
  skip: number;
  includePmu?: boolean;
  includeP2d?: boolean;
};

type DailySalesRow = {
  id: string;
  date: string;
  storeName: string;
  shiftCount: number;
  cash: number;
  card: number;
  cheque: number;
  pgLink: number;
  wallet: number;
  total: number;
};

const emptyPaged = () => ({rows: [], totalCount: 0, totals: {}});

/** Local YYYY-MM-DD, so a day is grouped by the store's own calendar. */
function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/** Shared shape for the paged, order-backed reports. */
export type PagedReport<TRow> = {
  rows: TRow[];
  totalCount: number;
  totals: Record<string, number>;
};

export type ModeOfPaymentReport = {
  rows: ModeOfPaymentRow[];
  totalCount: number;
  totals: {amount: number; reimbursement: number};
};

/**
 * Report aggregations, computed server-side.
 *
 * These exist because the client versions fetched a capped page of orders
 * and summed them in the browser: past the cap the totals were silently
 * wrong, with nothing on screen to say so.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class ReportsService {
  constructor(
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(PaymentTransactionRepository)
    private paymentTransactionRepo: PaymentTransactionRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(ShiftRepository) private shiftRepo: ShiftRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
    @repository(RegionRepository) private regionRepo: RegionRepository,
    @repository(CustomerLabelRepository) private customerLabelRepo: CustomerLabelRepository,
    @repository(CustomerLabelAssignmentRepository)
    private customerLabelAssignmentRepo: CustomerLabelAssignmentRepository,
    @repository(DeliveryOrderRepository) private deliveryOrderRepo: DeliveryOrderRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(PettyCashRegisterEntryRepository)
    private pettyCashRegisterRepo: PettyCashRegisterEntryRepository,
  ) {}

  /**
   * Mode Of Payment — one row per PAYMENT, not per order.
   *
   * This is the correction that matters versus the old client-side
   * version: that one printed one row per order, pairing the order's
   * FULL collected amount with only its LAST payment mode. An order
   * settled ₹500 cash + ₹500 card was reported as ₹1000 card, so the
   * per-mode totals this report exists to produce did not reconcile.
   * Reading the payment transactions directly gives each tender its own
   * row and its own mode.
   *
   * Refunds land in `reimbursement` rather than `amount`, so the column
   * carries real numbers instead of the constant zero it showed before.
   */
  async buildModeOfPayment(params: {
    storeIds: string[];
    from: Date;
    to: Date;
    limit: number;
    skip: number;
  }): Promise<ModeOfPaymentReport> {
    const {storeIds, from, to, limit, skip} = params;
    const empty: ModeOfPaymentReport = {
      rows: [],
      totalCount: 0,
      totals: {amount: 0, reimbursement: 0},
    };
    if (!storeIds.length) return empty;

    // Payments carry no storeId — they reach a store through their order,
    // and an order raised months ago can still be paid inside this
    // window, so the order set deliberately is NOT date-filtered.
    const orders = await this.orderRepo.find({
      where: {storeId: {inq: storeIds}} as object,
      fields: {
        id: true,
        orderNumber: true,
        storeId: true,
        shiftId: true,
        placedByName: true,
        customerId: true,
      } as object,
    });
    if (!orders.length) return empty;

    const orderById = new Map(orders.map(o => [o.id, o]));
    const orderIds = orders.map(o => o.id);

    const where = {
      orderId: {inq: orderIds},
      paymentDate: {between: [from, to]},
    } as object;

    // Count and totals come from the whole matching set, never just the
    // page — a footer that only summed the visible rows would restate the
    // very bug this endpoint replaces.
    const [{count}, pageRows, allAmounts] = await Promise.all([
      this.paymentTransactionRepo.count(where),
      this.paymentTransactionRepo.find({
        where,
        order: ['paymentDate DESC'],
        limit,
        skip,
      }),
      this.paymentTransactionRepo.find({
        where,
        fields: {amount: true, transactionType: true} as object,
      }),
    ]);

    const totals = allAmounts.reduce(
      (acc, t) => {
        const value = Number(t.amount) || 0;
        if (t.transactionType === 'refund') acc.reimbursement += value;
        else acc.amount += value;
        return acc;
      },
      {amount: 0, reimbursement: 0},
    );

    const [storeById, shiftById, customerById] = await Promise.all([
      this.mapStores(pageRows, orderById),
      this.mapShifts(pageRows, orderById),
      this.mapCustomers(pageRows, orderById),
    ]);

    const rows: ModeOfPaymentRow[] = pageRows.map(txn => {
      const order = orderById.get(txn.orderId);
      const isRefund = txn.transactionType === 'refund';
      const value = Number(txn.amount) || 0;
      const shift = order?.shiftId ? shiftById.get(String(order.shiftId)) : undefined;
      const customer = order?.customerId ? customerById.get(String(order.customerId)) : undefined;
      const customerName = customer
        ? `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim()
        : '';

      return {
        id: String(txn.id),
        storeName: (order?.storeId && storeById.get(String(order.storeId))) || '—',
        date: txn.paymentDate ?? null,
        // closureNo exists only once a shift has been closed; an open
        // shift has no closure number yet, which is not missing data.
        shiftClosureNo: shift?.closureNo != null ? String(shift.closureNo) : '—',
        ticketNo: order?.orderNumber ?? '—',
        userName: order?.placedByName || customerName || '—',
        amount: isRefund ? 0 : value,
        reimbursement: isRefund ? value : 0,
        paymentMode: String(txn.paymentMode ?? ''),
        paymentModeLabel: PAYMENT_MODE_LABELS[txn.paymentMode] ?? String(txn.paymentMode ?? '—'),
      };
    });

    return {rows, totalCount: count, totals};
  }

  /**
   * Pending Payments — orders still owing money.
   *
   * balanceDue is derived from the payment transactions rather than
   * trusted from a column, so "pending" means genuinely unsettled.
   */
  async buildPendingPayments(params: OrderReportParams & {
    paymentStatus: string;
    deliveryStatus: string;
    customerLabelId?: string;
  }): Promise<PagedReport<object>> {
    const {storeIds, from, to, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const orders = await this.orderRepo.find({
      where: {
        ...this.orderScopeWhere(params),
        status: {neq: OrderStatus.CANCELLED},
      } as object,
      order: ['createdAt DESC'],
    });
    if (!orders.length) return emptyPaged();

    const orderIds = orders.map(o => o.id);
    const [collected, deliveryStatuses, storeCtx, customerCtx] = await Promise.all([
      this.buildCollectedByOrder(orderIds),
      this.buildDeliveryStatusByOrder(orderIds),
      this.buildStoreContext(storeIds),
      this.buildCustomerContext([...new Set(orders.map(o => String(o.customerId)))]),
    ]);

    const enriched = orders
      .map(order => {
        const total = Number(order.totalAmount) || 0;
        const paid = collected.get(String(order.id)) ?? 0;
        // Round to paise before comparing; float residue would otherwise
        // leave fully-settled orders showing a fractional balance.
        const balanceDue = Math.round((total - paid) * 100) / 100;
        const status = balanceDue <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending';
        return {order, balanceDue, status, delivery: deliveryStatuses.get(String(order.id)) ?? ''};
      })
      .filter(({status, delivery}) => {
        const wanted = params.paymentStatus;
        if (wanted === 'pending' && status === 'paid') return false;
        if (wanted !== 'all' && wanted !== 'pending' && status !== wanted) return false;
        if (params.deliveryStatus !== 'all' && delivery.toLowerCase() !== params.deliveryStatus) {
          return false;
        }
        return true;
      })
      .filter(({order}) => {
        if (!params.customerLabelId) return true;
        return customerCtx.get(String(order.customerId))?.groupId === params.customerLabelId;
      });

    const totals = {
      balanceDue: enriched.reduce((sum, e) => sum + e.balanceDue, 0),
    };

    const rows = enriched.slice(skip, skip + limit).map(({order, balanceDue, status, delivery}) => {
      const store = storeCtx.get(String(order.storeId));
      const customer = customerCtx.get(String(order.customerId));
      return {
        id: String(order.id),
        bu: BUSINESS_UNIT,
        region: store?.regionName ?? '—',
        customerGroup: customer?.groupName ?? '—',
        storeName: store?.name ?? '—',
        customerCode: customer?.code ?? '—',
        customerName: customer?.name ?? '—',
        ticketNo: order.orderNumber ?? '—',
        deliveryStatus: delivery || '—',
        paymentStatus: status,
        balanceDue,
        orderDate: order.createdAt ?? null,
      };
    });

    return {rows, totalCount: enriched.length, totals};
  }

  /**
   * Pending Tickets — orders still in the plant, not yet delivered.
   *
   * "No Of Items" counts garments. The client read order.itemCount, a
   * field the order-list endpoint does not return (it sends
   * orderItemsCount), so this column has been showing 0 throughout.
   */
  async buildPendingTickets(params: OrderReportParams): Promise<PagedReport<object>> {
    const {storeIds, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const orders = await this.orderRepo.find({
      where: {
        ...this.orderScopeWhere(params),
        status: {nin: TICKET_TERMINAL_STATUSES},
      } as object,
      order: ['createdAt DESC'],
    });
    if (!orders.length) return emptyPaged();

    const orderIds = orders.map(o => o.id);
    const [itemCounts, deliveryStatuses, storeCtx, customerCtx] = await Promise.all([
      this.buildItemCountByOrder(orderIds),
      this.buildDeliveryStatusByOrder(orderIds),
      this.buildStoreContext(storeIds),
      this.buildCustomerContext([...new Set(orders.map(o => String(o.customerId)))]),
    ]);

    // An order already handed over is no longer pending, whatever its
    // own status says.
    const pending = orders.filter(
      o => (deliveryStatuses.get(String(o.id)) ?? '').toLowerCase() !== 'delivered',
    );

    const totals = {
      amount: pending.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0),
      items: pending.reduce((sum, o) => sum + (itemCounts.get(String(o.id)) ?? 0), 0),
    };

    const rows = pending.slice(skip, skip + limit).map(order => {
      const store = storeCtx.get(String(order.storeId));
      const customer = customerCtx.get(String(order.customerId));
      return {
        id: String(order.id),
        bu: BUSINESS_UNIT,
        region: store?.regionName ?? '—',
        cluster: store?.clusterName ?? '—',
        storeName: store?.name ?? '—',
        ticketNo: order.orderNumber ?? '—',
        customerCode: customer?.code ?? '—',
        customerName: customer?.name ?? '—',
        itemCount: itemCounts.get(String(order.id)) ?? 0,
        receptionDate: order.createdAt ?? null,
        estDeliveryDate: order.deliveryDate ?? null,
        ticketStatus: order.status ?? '—',
        deliveryStatus: deliveryStatuses.get(String(order.id)) || '—',
        amount: Number(order.totalAmount) || 0,
      };
    });

    return {rows, totalCount: pending.length, totals};
  }

  /**
   * On Account Billing — orders genuinely billed on account.
   *
   * Selected on Order.isOnAccount, the flag persisted at creation for
   * exactly this purpose. The client version matched on lastPaymentMode
   * instead, which on-account orders never carry: they are deferred
   * billing and so record no payment transaction at all (see
   * OrderService.recordPayment). Any order not yet paid was therefore
   * invisible to the report it exists to produce.
   */
  async buildOnAccountBilling(params: OrderReportParams & {
    deliveryStatus: string;
    paymentStatus: string;
    customerName?: string;
  }): Promise<PagedReport<object>> {
    const {storeIds, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const orders = await this.orderRepo.find({
      where: {
        ...this.orderScopeWhere(params),
        isOnAccount: true,
        status: {neq: OrderStatus.CANCELLED},
      } as object,
      order: ['createdAt DESC'],
    });
    if (!orders.length) return emptyPaged();

    const orderIds = orders.map(o => o.id);
    const [collected, deliveryStatuses, storeCtx, customerCtx] = await Promise.all([
      this.buildCollectedByOrder(orderIds),
      this.buildDeliveryStatusByOrder(orderIds),
      this.buildStoreContext(storeIds),
      this.buildCustomerContext([...new Set(orders.map(o => String(o.customerId)))]),
    ]);

    const needle = (params.customerName ?? '').trim().toLowerCase();

    const enriched = orders
      .map(order => {
        const total = Number(order.totalAmount) || 0;
        const paid = collected.get(String(order.id)) ?? 0;
        const balanceDue = Math.round((total - paid) * 100) / 100;
        return {
          order,
          total,
          paid,
          balanceDue,
          status: balanceDue <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending',
          delivery: deliveryStatuses.get(String(order.id)) ?? '',
        };
      })
      .filter(({status, delivery, order}) => {
        if (params.paymentStatus !== 'all' && status !== params.paymentStatus) return false;
        if (params.deliveryStatus !== 'all' && delivery.toLowerCase() !== params.deliveryStatus) {
          return false;
        }
        if (needle) {
          const name = (customerCtx.get(String(order.customerId))?.name ?? '').toLowerCase();
          if (!name.includes(needle)) return false;
        }
        return true;
      });

    const totals = {
      totalAmount: enriched.reduce((sum, e) => sum + e.total, 0),
      collected: enriched.reduce((sum, e) => sum + e.paid, 0),
      balanceDue: enriched.reduce((sum, e) => sum + e.balanceDue, 0),
    };

    const rows = enriched.slice(skip, skip + limit).map(e => {
      const store = storeCtx.get(String(e.order.storeId));
      const customer = customerCtx.get(String(e.order.customerId));
      return {
        id: String(e.order.id),
        bu: BUSINESS_UNIT,
        region: store?.regionName ?? '—',
        cluster: store?.clusterName ?? '—',
        storeName: store?.name ?? '—',
        customerCode: customer?.code ?? '—',
        customerName: customer?.name ?? '—',
        ticketNo: e.order.orderNumber ?? '—',
        orderDate: e.order.createdAt ?? null,
        deliveryStatus: e.delivery || '—',
        paymentStatus: e.status,
        totalAmount: e.total,
        collected: e.paid,
        balanceDue: e.balanceDue,
      };
    });

    return {rows, totalCount: enriched.length, totals};
  }

  /**
   * Consolidated Daily Sales — one row per closed shift per store per
   * day, with the operator-entered closing collections.
   *
   * Only CLOSED shifts appear: an open shift has no closing form yet, so
   * it has no reconciled collections to report.
   */
  async buildConsolidatedDailySales(params: {
    storeIds: string[];
    from: Date;
    to: Date;
  }): Promise<PagedReport<object>> {
    const {storeIds, from, to} = params;
    if (!storeIds.length) return emptyPaged();

    const [shifts, storeCtx] = await Promise.all([
      this.shiftRepo.find({
        where: {
          storeId: {inq: storeIds},
          status: ShiftStatus.CLOSED,
          closedAt: {between: [from, to]},
        } as object,
        order: ['closedAt ASC'],
      }),
      this.buildStoreContext(storeIds),
    ]);
    if (!shifts.length) return emptyPaged();

    const grouped = new Map<string, DailySalesRow>();
    for (const shift of shifts) {
      if (!shift.closedAt) continue;
      const day = toDateKey(new Date(shift.closedAt));
      const key = `${day}|${shift.storeId}`;
      const collections =
        ((shift.closing as {collections?: Record<string, unknown>} | undefined)?.collections ??
          {}) as Record<string, unknown>;

      const row =
        grouped.get(key) ??
        {
          id: key,
          date: day,
          storeName: storeCtx.get(String(shift.storeId))?.name ?? '—',
          shiftCount: 0,
          cash: 0,
          card: 0,
          cheque: 0,
          pgLink: 0,
          wallet: 0,
          total: 0,
        };

      row.shiftCount += 1;
      row.cash += Number(collections.cash) || 0;
      row.card += Number(collections.card) || 0;
      row.cheque += Number(collections.cheque) || 0;
      row.pgLink += Number(collections.pgLink) || 0;
      row.wallet += Number(collections.wallet) || 0;
      row.total = row.cash + row.card + row.cheque + row.pgLink + row.wallet;
      grouped.set(key, row);
    }

    const rows = [...grouped.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.storeName.localeCompare(b.storeName),
    );

    return {
      rows,
      totalCount: rows.length,
      totals: {
        cash: rows.reduce((s, r) => s + r.cash, 0),
        card: rows.reduce((s, r) => s + r.card, 0),
        cheque: rows.reduce((s, r) => s + r.cheque, 0),
        pgLink: rows.reduce((s, r) => s + r.pgLink, 0),
        wallet: rows.reduce((s, r) => s + r.wallet, 0),
        total: rows.reduce((s, r) => s + r.total, 0),
      },
    };
  }

  /** Petty Cash Expense — register entries for the window. */
  async buildPettyCashExpense(params: {
    storeIds: string[];
    from: Date;
    to: Date;
    limit: number;
    skip: number;
  }): Promise<PagedReport<object>> {
    const {storeIds, from, to, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const where = {
      storeId: {inq: storeIds},
      isDeleted: false,
      expenseDate: {between: [from, to]},
    } as object;

    const [{count}, pageRows, allRows] = await Promise.all([
      this.pettyCashRegisterRepo.count(where),
      this.pettyCashRegisterRepo.find({where, order: ['expenseDate DESC'], limit, skip}),
      this.pettyCashRegisterRepo.find({
        where,
        fields: {amount: true, approvedAmount: true} as object,
      }),
    ]);

    return {
      rows: pageRows.map(entry => ({
        id: String(entry.id),
        expenseDate: entry.expenseDate ?? null,
        description: entry.description ?? '—',
        remarks: entry.remarks ?? '—',
        method: entry.method ?? '—',
        recordedBy: entry.userName ?? '—',
        storeName: entry.storeName ?? '—',
        amount: Number(entry.amount) || 0,
        // approvedAmount is only set once a manager resolves the entry;
        // until then there is no approved figure, not a zero one.
        approvedAmount: entry.approvedAmount == null ? null : Number(entry.approvedAmount),
        status: entry.status ?? 'pending',
      })),
      totalCount: count,
      totals: {
        claimed: allRows.reduce((s, e) => s + (Number(e.amount) || 0), 0),
        approved: allRows.reduce((s, e) => s + (Number(e.approvedAmount) || 0), 0),
      },
    };
  }

  /** Shared `where` for the order-backed reports: scope, window, P2D. */
  private orderScopeWhere(params: OrderReportParams): object {
    const where: Record<string, unknown> = {
      storeId: {inq: params.storeIds},
      createdAt: {between: [params.from, params.to]},
    };
    // PMU has no schema equivalent, so selecting only PMU matches nothing
    // rather than quietly returning every order.
    if (params.includeP2d && !params.includePmu) {
      where.orderType = {inq: P2D_ORDER_TYPES};
    } else if (params.includePmu && !params.includeP2d) {
      where.orderType = {inq: []};
    }
    return where;
  }

  /**
   * Store name plus its cluster and region, keyed by store id.
   *
   * The order-list endpoint returns only a flat storeName, which is why
   * the Region and Cluster columns on these reports have been rendering
   * "—" — the client was reading order.store.region.name off a nested
   * object that was never sent. Walking store -> cluster -> region here
   * fills them in properly.
   */
  private async buildStoreContext(storeIds: string[]) {
    const stores = await this.storeRepo.find({
      where: {id: {inq: storeIds}} as object,
      fields: {id: true, name: true, code: true, clusterId: true} as object,
    });

    const clusterIds = [...new Set(stores.map(s => s.clusterId).filter(Boolean))] as string[];
    const clusters = clusterIds.length
      ? await this.clusterRepo.find({
          where: {id: {inq: clusterIds}} as object,
          fields: {id: true, name: true, regionId: true} as object,
        })
      : [];

    const regionIds = [...new Set(clusters.map(c => c.regionId).filter(Boolean))] as string[];
    const regions = regionIds.length
      ? await this.regionRepo.find({
          where: {id: {inq: regionIds}} as object,
          fields: {id: true, name: true} as object,
        })
      : [];

    const regionById = new Map(regions.map(r => [String(r.id), r.name]));
    const clusterById = new Map(
      clusters.map(c => [
        String(c.id),
        {name: c.name, regionName: regionById.get(String(c.regionId)) ?? '—'},
      ]),
    );

    return new Map(
      stores.map(s => {
        const cluster = s.clusterId ? clusterById.get(String(s.clusterId)) : undefined;
        return [
          String(s.id),
          {
            name: s.name ?? String(s.code ?? '—'),
            clusterName: cluster?.name ?? '—',
            regionName: cluster?.regionName ?? '—',
          },
        ];
      }),
    );
  }

  /**
   * Customer name, code and group label for the given customer ids.
   *
   * customerCode is a real column but is absent from the order-list
   * response, so the client fell back to printing the raw customer UUID
   * in the "Customer Code" column.
   */
  private async buildCustomerContext(customerIds: string[]) {
    if (!customerIds.length) return new Map<string, CustomerContext>();

    const [customers, assignments] = await Promise.all([
      this.customerRepo.find({
        where: {id: {inq: customerIds}} as object,
        fields: {id: true, firstName: true, lastName: true, customerCode: true} as object,
      }),
      this.customerLabelAssignmentRepo.find({
        where: {customerId: {inq: customerIds}} as object,
      }),
    ]);

    const labelIds = [
      ...new Set(
        assignments
          .map(a => (a as unknown as {customerLabelId?: string}).customerLabelId)
          .filter(Boolean),
      ),
    ] as string[];
    const labels = labelIds.length
      ? await this.customerLabelRepo.find({
          where: {id: {inq: labelIds}} as object,
          fields: {id: true, name: true} as object,
        })
      : [];
    const labelNameById = new Map(labels.map(l => [String(l.id), l.name]));

    // A customer can carry several labels; the report has one column, so
    // the first assigned label is shown rather than an arbitrary join.
    const labelByCustomer = new Map<string, string>();
    const labelIdByCustomer = new Map<string, string>();
    for (const a of assignments) {
      const row = a as unknown as {customerId?: string; customerLabelId?: string};
      if (!row.customerId || labelByCustomer.has(String(row.customerId))) continue;
      const name = labelNameById.get(String(row.customerLabelId));
      if (name) {
        labelByCustomer.set(String(row.customerId), name);
        labelIdByCustomer.set(String(row.customerId), String(row.customerLabelId));
      }
    }

    return new Map<string, CustomerContext>(
      customers.map(c => [
        String(c.id),
        {
          name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '—',
          code: c.customerCode ?? '—',
          groupName: labelByCustomer.get(String(c.id)) ?? '—',
          groupId: labelIdByCustomer.get(String(c.id)) ?? '',
        },
      ]),
    );
  }

  /**
   * Delivery status per order id.
   *
   * deliveryStatus is not a column on Order — the order-list endpoint
   * reads it through an `as any` cast, so it is always undefined there.
   * The real value lives on the delivery_order row for that order.
   */
  private async buildDeliveryStatusByOrder(orderIds: string[]) {
    if (!orderIds.length) return new Map<string, string>();
    const rows = await this.deliveryOrderRepo.find({
      where: {orderId: {inq: orderIds}} as object,
      fields: {orderId: true, status: true} as object,
    });
    const byOrder = new Map<string, string>();
    for (const row of rows) {
      if (row.orderId) byOrder.set(String(row.orderId), String(row.status ?? ''));
    }
    return byOrder;
  }

  /** Money actually collected per order, for balance-due maths. */
  private async buildCollectedByOrder(orderIds: string[]) {
    if (!orderIds.length) return new Map<string, number>();
    const txns = await this.paymentTransactionRepo.find({
      where: {
        orderId: {inq: orderIds},
        transactionType: {neq: 'refund'},
      } as object,
      fields: {orderId: true, amount: true} as object,
    });
    const byOrder = new Map<string, number>();
    for (const t of txns) {
      byOrder.set(String(t.orderId), (byOrder.get(String(t.orderId)) ?? 0) + (Number(t.amount) || 0));
    }
    return byOrder;
  }

  /** Garment count per order — the "No Of Items" column. */
  private async buildItemCountByOrder(orderIds: string[]) {
    if (!orderIds.length) return new Map<string, number>();
    const orderItems = await this.orderItemRepo.find({
      where: {orderId: {inq: orderIds}} as object,
      fields: {id: true, orderId: true} as object,
    });
    if (!orderItems.length) return new Map<string, number>();

    const orderByItem = new Map(orderItems.map(oi => [String(oi.id), String(oi.orderId)]));
    const garments = await this.garmentRepo.find({
      where: {orderItemId: {inq: orderItems.map(oi => oi.id)}, isDeleted: false} as object,
      fields: {orderItemId: true} as object,
    });

    const byOrder = new Map<string, number>();
    for (const g of garments) {
      const orderId = orderByItem.get(String(g.orderItemId));
      if (orderId) byOrder.set(orderId, (byOrder.get(orderId) ?? 0) + 1);
    }
    return byOrder;
  }

  // ─── Lookup helpers — resolved for the current page only ──────────────────

  private async mapStores(
    txns: {orderId: string}[],
    orderById: Map<string, {storeId?: string}>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        txns.map(t => orderById.get(t.orderId)?.storeId).filter(Boolean) as string[],
      ),
    ];
    if (!ids.length) return new Map();
    const stores = await this.storeRepo.find({
      where: {id: {inq: ids}} as object,
      fields: {id: true, name: true, code: true} as object,
    });
    return new Map(stores.map(s => [String(s.id), s.name ?? String(s.code ?? '')]));
  }

  private async mapShifts(
    txns: {orderId: string}[],
    orderById: Map<string, {shiftId?: string}>,
  ): Promise<Map<string, {closureNo?: number}>> {
    const ids = [
      ...new Set(txns.map(t => orderById.get(t.orderId)?.shiftId).filter(Boolean) as string[]),
    ];
    if (!ids.length) return new Map();
    const shifts = await this.shiftRepo.find({
      where: {id: {inq: ids}} as object,
      fields: {id: true, closureNo: true} as object,
    });
    return new Map(shifts.map(s => [String(s.id), {closureNo: s.closureNo}]));
  }

  private async mapCustomers(
    txns: {orderId: string}[],
    orderById: Map<string, {customerId?: string}>,
  ): Promise<Map<string, {firstName?: string; lastName?: string}>> {
    const ids = [
      ...new Set(txns.map(t => orderById.get(t.orderId)?.customerId).filter(Boolean) as string[]),
    ];
    if (!ids.length) return new Map();
    const customers = await this.customerRepo.find({
      where: {id: {inq: ids}} as object,
      fields: {id: true, firstName: true, lastName: true} as object,
    });
    return new Map(
      customers.map(c => [String(c.id), {firstName: c.firstName, lastName: c.lastName}]),
    );
  }
}
