import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {PaymentMode} from '../models/payment-mode.enum';
import {
  CustomerRepository,
  OrderRepository,
  PaymentTransactionRepository,
  ShiftRepository,
  StoreRepository,
} from '../repositories';

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
