import {PAYMENT_REPORT_SQL} from '../utils/payment-report-sql';
import {PETTY_CASH_REPORT_SQL} from '../utils/petty-cash-report-sql';
import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {findInBatches} from '../utils/batch-find';
import {InvoiceStatus} from '../models/invoice.model';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {PaymentRequestStatus} from '../models/payment-request-status.enum';
import {PettyCashStatus} from '../models/petty-cash-status.enum';
import {SalesReturnStatus} from '../models/sales-return.model';
import {ShiftStatus} from '../models/shift-status.enum';
import {
  ClusterRepository,
  CustomerAddressRepository,
  CustomerLabelAssignmentRepository,
  CustomerLabelRepository,
  CustomerRepository,
  DeliveryOrderRepository,
  GarmentRepository,
  GstTaxConfigurationRepository,
  InvoiceOrderLinkRepository,
  InvoiceRepository,
  ItemRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  PettyCashFinanceEntryRepository,
  PettyCashRegisterEntryRepository,
  RegionRepository,
  SalesReturnRepository,
  ShiftRepository,
  StoreMonthlyTargetRepository,
  StoreRepository,
  UsersRepository,
  WalletRechargeRequestRepository,
} from '../repositories';
import {resolveOrderPaymentStatus} from '../utils/payment-status';

/** Fixed business-unit label; the schema carries no BU dimension yet. */
const BUSINESS_UNIT = 'Pressto';

// Sales Report of GST: the business files GST under one single registered
// entity/address, not a separate GSTIN per store, so the "Seller" block is
// the same fixed constant on every row (confirmed with the client).
const SALES_GST_SELLER = {
  gstin: '27AAECP3228Q2ZX',
  legalName: 'PRESS2 DRYCLEANING AND LAUNDRY PRIVATE LIMITED',
  addr1: 'Shop No 7 Kenwood Chs Ground Floor 89, Ambedkar Rd Zig Zag Road',
  addr2: 'Junction Bandra -W, Bandra (West), Mumbai, Maharashtra - 400050',
  locationName: 'MUMBAI',
  pincode: '400050',
  stateCode: '27',
};

// One SAC code for every line — dry cleaning/laundry services all file
// under the same code, confirmed with the client (not per-item/service).
const SALES_GST_SAC_CODE = '999712';

/** GST state codes (the 2-digit prefix of every GSTIN), keyed by lowercase state name. */
const GST_STATE_CODE_BY_NAME: Record<string, string> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  haryana: '06',
  delhi: '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  chhattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  'daman and diu': '25',
  'dadra and nagar haveli': '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  puducherry: '34',
  'andaman and nicobar islands': '35',
  telangana: '36',
  'andhra pradesh': '37',
  ladakh: '38',
};

/** Buyer's GST state code: prefer the 2-digit prefix of their own GSTIN (authoritative for a B2B buyer), else look up their address's state name. */
function resolveBuyerStateCode(gstNumber?: string, stateName?: string): string {
  if (gstNumber && gstNumber.length >= 2) return gstNumber.slice(0, 2);
  const key = (stateName ?? '').trim().toLowerCase();
  return GST_STATE_CODE_BY_NAME[key] ?? '—';
}

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
  [PaymentMode.PP_VOUCHER]: 'PP Voucher',
};

export type ModeOfPaymentRow = {
  id: string;
  storeName: string;
  date: Date | null;
  shiftClosureNo: string;
  ticketNo: string;
  invoiceNo: string;
  userName: string;
  customerNameWithCode: string;
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
  day: string;
  date: string;
  closureNo: string;
  storeName: string;
  storeCode: string;
  clusterName: string;
  regionName: string;
  psbRevenue: number;
  pmuRevenue: number;
  p2dRevenue: number;
  revenue: number;
  // Store's monthly revenue target (StoreMonthlyTarget), spread evenly
  // across that month's days — e.g. a ₹31,000 January target becomes
  // ₹1,000/day. null when no target is set for that store+month.
  targetRevenue: number | null;
  discount: number;
  discountedRevenue: number;
  taxes: number;
  totalSales: number;
  noOfTickets: number;
  noOfItems: number;
  noOfServices: number;
  otherPaymentMode: number;
  ppVouchers: number;
  cash: number;
  cardsUpi: number;
  chequesReceived: number;
  reimbursed: number;
  pgLink: number;
  wallet: number;
  walletRechargedCash: number;
  walletRechargedOther: number;
  totalReceipts: number;
  supposedBankDeposit: number;
  actualBankDeposit: number;
  diffInDeposit: number;
  noOfSalesReturnServices: number;
  salesReturnSaleAmount: number;
  shiftOpenRemark: string;
  shiftClosingRemark: string;
  cumulativeDifference: string;
};

/** The revenue.pressto / salesReturn.pressto shape stored on Shift.closing. */
type ShiftRevenueCell = {
  revenue?: number;
  discount?: number;
  taxes?: number;
  totalSales?: number;
  tickets?: number;
  items?: number;
  services?: number;
};

type ShiftClosingSnapshot = {
  remarks?: string;
  revenue?: {pressto?: ShiftRevenueCell};
  salesReturn?: {pressto?: ShiftRevenueCell};
  collections?: {
    cash?: number;
    card?: number;
    upi?: number;
    cheque?: number;
    pgLink?: number;
    wallet?: number;
    ppVoucher?: number;
  };
  // Cash/card/UPI/net-banking taken in for WALLET TOP-UPS specifically — a
  // separate money-in event from a ticket payment, prefilled for the
  // closing form by ShiftController.collected() and stored verbatim here
  // once the cashier submits. Distinct from collections.wallet above, which
  // is stored-wallet-balance REDEMPTION against a ticket (no fresh money).
  walletCollections?: {cash?: number; card?: number; upi?: number; netBanking?: number; ppVoucher?: number};
  register?: {reimbursement?: number};
  banking?: {supposed?: number; deposited?: number; inSafe?: number; cumulativeDiff?: number};
  pettyCash?: {cumulativeDiff?: number};
  ppVoucher?: {cumulativeDiff?: number};
  actualCashInTill?: {cumulativeDiff?: number};
  itpv?: {
    pReport?: {revenue?: ShiftRevenueCell; salesReturn?: ShiftRevenueCell};
    zReport?: {revenue?: ShiftRevenueCell; salesReturn?: ShiftRevenueCell};
  };
};

/** Order types booked as a walk-in/counter sale — the "PSB" revenue bucket. */
const PSB_ORDER_TYPES = [OrderType.STORE_DROPOFF, OrderType.STORE_DROPOFF_HOME_DELIVERY];

/** Preserve the legacy PSB/P2D split for reports before the agreed cutover. */
const ITPV_PZ_SPLIT_EFFECTIVE_DATE = '2026-10-01';

/**
 * Payment modes that land in the Daily Sales Report's "Other Payment Mode"
 * catch-all — everything Shift.closing.collections never bucketed on its
 * own (that object only ever tracks cash/card/UPI/cheque/pgLink/wallet/
 * ppVoucher — see collections above), so a net banking, bank transfer, PDC
 * or pay-later payment falls through it entirely today.
 */
const OTHER_PAYMENT_MODES = new Set<string>([
  PaymentMode.NET_BANKING,
  PaymentMode.BANK_TRANSFER,
  PaymentMode.PDC,
  PaymentMode.PAY_LATER,
]);

const emptyPaged = () => ({rows: [], totalCount: 0, totals: {}});

/** Sort key for a nullable date; undated rows sink to the bottom. */
function timeOf(date: Date | null | undefined): number {
  return date ? new Date(date).getTime() : 0;
}

/** Local YYYY-MM-DD, so a day is grouped by the store's own calendar. */
function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/** Round to paise — plain JS float addition otherwise drifts over many rows. */
function roundRupees(value: number): number {
  return Math.round(value * 100) / 100;
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
  // Amount collected per payment mode, across the whole matching set (not
  // just the current page) — shown at the top of the report, e.g. "Cash
  // 45000", one figure per mode. Keyed by the same display label as each
  // row's paymentModeLabel, so it reads the same way on screen.
  totalsByMode: Record<string, number>;
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
    @repository(PettyCashFinanceEntryRepository)
    private pettyCashFinanceRepo: PettyCashFinanceEntryRepository,
    @repository(WalletRechargeRequestRepository)
    private walletRechargeRequestRepo: WalletRechargeRequestRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(InvoiceOrderLinkRepository)
    private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
    @repository(SalesReturnRepository)
    private salesReturnRepo: SalesReturnRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @repository(CustomerAddressRepository)
    private customerAddressRepo: CustomerAddressRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(GstTaxConfigurationRepository)
    private gstTaxConfigurationRepo: GstTaxConfigurationRepository,
    @repository(StoreMonthlyTargetRepository)
    private storeMonthlyTargetRepo: StoreMonthlyTargetRepository,
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
   *
   * Wallet top-ups are folded into the same list — money the store took
   * over the counter too, just not against a ticket. They reach a store
   * through the customer's preferred store (see buildWalletTopUpRows)
   * and are told apart on screen by their ticket cell, which reads
   * `Wallet Recharge`. Note that a top-up AND the wallet-mode
   * payment it later funds both appear: this report lists tenders taken,
   * so summing every row double-counts wallet money by design.
   *
   * Generating an On Account invoice moves no money, so it is excluded.
   * The eventual payment appears once, under the mode actually collected.
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
      totalsByMode: {},
    };
    if (!storeIds.length) return empty;

    const result = await this.paymentTransactionRepo.execute(PAYMENT_REPORT_SQL, [storeIds, from, to, limit, skip]);
    const summary = result[0];
    if (!Number(summary.count)) return empty;
    const selected: {id: string; sourceid: string; kind: string; cashshiftid?: string}[] = summary.page;
    const paymentIds = selected.filter(row => row.kind === 'payment').map(row => row.sourceid);
    const walletIds = selected.filter(row => row.kind === 'wallet').map(row => row.sourceid);
    const cashShiftIds = selected.map(row => row.cashshiftid).filter(Boolean) as string[];
    const selectedKeys = new Set(selected.map(row => row.id));
    // Payments reach a store through their order, except cash refunds with
    // a payout shift, and an old order can still be paid in this window —
    // so the order side can't be date-filtered directly. Rather than fetch
    // every order the store(s) have ever raised (unbounded by date, and
    // can approach the whole orders table across many/all stores), fetch
    // candidate payments by date first — indexed, bounded by the window —
    // then resolve only the specific orders they actually reference.
    const [candidatePayments, cashShifts, walletRows] = await Promise.all([
      this.paymentTransactionRepo.find({
        where: {id: {inq: paymentIds}} as object,
        order: ['paymentDate DESC'],
      }),
      this.shiftRepo.find({
        where: {storeId: {inq: storeIds}, id: {inq: cashShiftIds}} as object,
        fields: {id: true, storeId: true, storeCode: true, storeName: true, closureNo: true} as object,
      }),
      this.buildWalletTopUpRows(storeIds, from, to, walletIds),
    ]);

    const cashShiftById = new Map(cashShifts.map(shift => [shift.id, shift]));
    const cashShiftIdSet = new Set(cashShifts.map(shift => shift.id));
    const cashPayouts = candidatePayments.filter(payment =>
      payment.transactionType === 'refund' && payment.paymentMode === PaymentMode.CASH &&
      payment.cashShiftId && cashShiftIdSet.has(payment.cashShiftId));

    const candidateOrderIds = [...new Set(candidatePayments.map(payment => payment.orderId))];
    const orders = await findInBatches(candidateOrderIds, batch =>
      this.orderRepo.find({
        where: {id: {inq: batch}, storeId: {inq: storeIds}} as object,
        fields: {
          id: true,
          orderNumber: true,
          storeId: true,
          shiftId: true,
          placedByName: true,
          customerId: true,
        } as object,
      }),
    );
    const orderById = new Map(orders.map(o => [o.id, o]));
    const orderPayments = candidatePayments.filter(payment => orderById.has(payment.orderId));
    const onAccountInvoiceNumberByOrderId = await this.mapOnAccountInvoiceNumbers(
      orders.map(o => o.id),
    );

    const payments = [...new Map([...orderPayments, ...cashPayouts]
      .filter(payment => payment.transactionType !== 'refund' ||
        payment.paymentMode !== PaymentMode.CASH || !payment.cashShiftId ||
        cashShiftById.has(payment.cashShiftId))
      .map(payment => [payment.id, payment])).values()];
    const missingOrderIds = [...new Set(payments.map(payment => payment.orderId)
      .filter(id => !orderById.has(id)))];
    if (missingOrderIds.length) {
      const payoutOrders = await this.orderRepo.find({
        where: {id: {inq: missingOrderIds}} as object,
        fields: {id: true, orderNumber: true, storeId: true, shiftId: true,
          placedByName: true, customerId: true} as object,
      });
      payoutOrders.forEach(order => orderById.set(order.id, order));
    }


    // The two ledgers are paged as one list, so the whole merged set has
    // to be ordered in memory before slicing: a DB-side limit/skip on the
    // payments alone would drop the top-ups that belong on the
    // same page.
    type Entry =
      | {date: Date | null; payment: (typeof payments)[number]; wallet?: undefined}
      | {date: Date | null; wallet: ModeOfPaymentRow; payment?: undefined};

    const entries: Entry[] = [
      ...payments.map(payment => ({date: payment.paymentDate ?? null, payment})),
      ...walletRows.filter(row => selectedKeys.has(row.id)).map(wallet => ({date: wallet.date, wallet})),
    ].sort((a, b) => timeOf(b.date) - timeOf(a.date));

    // Count and totals come from the whole matching set, never just the
    // page — a footer that only summed the visible rows would restate the
    // very bug this endpoint replaces.
    const totalsByMode: Record<string, number> = {};
    for (const [mode, amount] of Object.entries(summary.modes)) {
      const label = PAYMENT_MODE_LABELS[mode] ?? mode;
      totalsByMode[label] = roundRupees((totalsByMode[label] ?? 0) + Number(amount));
    }
    const totals = {amount: Number(summary.amount), reimbursement: Number(summary.refund)};

    const pageEntries = entries;
    const pagePayments = pageEntries
      .map(entry => entry.payment)
      .filter(Boolean) as typeof payments;

    const [storeById, shiftById, customerById, pageInvoices] = await Promise.all([
      this.mapStores(pagePayments, orderById),
      this.mapShifts(pagePayments, orderById),
      this.mapCustomers(pagePayments, orderById),
      pagePayments.length
        ? this.invoiceRepo.find({
            where: {
              orderId: {inq: [...new Set(pagePayments.map(payment => payment.orderId))]},
              status: InvoiceStatus.ISSUED,
            } as object,
            fields: {orderId: true, invoiceNumber: true} as object,
          })
        : [],
    ]);
    const invoiceNumberByOrderId = new Map(
      pageInvoices.map(invoice => [invoice.orderId, invoice.invoiceNumber]),
    );

    const rows: ModeOfPaymentRow[] = pageEntries.map(entry => {
      if (entry.wallet) return entry.wallet;
      const txn = entry.payment;
      const order = orderById.get(txn.orderId);
      const isRefund = txn.transactionType === 'refund';
      const value = Number(txn.amount) || 0;
      const cashShift = isRefund && txn.paymentMode === PaymentMode.CASH && txn.cashShiftId
        ? cashShiftById.get(txn.cashShiftId) : undefined;
      const shift = cashShift ?? (order?.shiftId ? shiftById.get(String(order.shiftId)) : undefined);
      const customer = order?.customerId ? customerById.get(String(order.customerId)) : undefined;
      const onAccountInvoiceNumber = onAccountInvoiceNumberByOrderId.get(txn.orderId);

      return {
        id: String(txn.id),
        storeName: cashShift
          ? (cashShift.storeName ?? cashShift.storeCode ?? storeById.get(cashShift.storeId) ?? '—')
          : order?.storeId ? (storeById.get(String(order.storeId)) ?? '—') : '—',
        date: txn.paymentDate ?? null,
        // closureNo exists only once a shift has been closed; an open
        // shift has no closure number yet, which is not missing data.
        shiftClosureNo: shift?.closureNo != null ? String(shift.closureNo) : '—',
        ticketNo: order?.orderNumber ?? '—',
        invoiceNo: onAccountInvoiceNumber ?? invoiceNumberByOrderId.get(txn.orderId) ?? '-',
        // The staff member who placed the ticket — never the customer, even
        // when placedByName is blank. Who bought it is its own column.
        userName: order?.placedByName ?? '—',
        customerNameWithCode: this.formatCustomerNameWithCode(customer),
        amount: isRefund ? 0 : value,
        reimbursement: isRefund ? value : 0,
        paymentMode: String(txn.paymentMode ?? ''),
        paymentModeLabel: PAYMENT_MODE_LABELS[txn.paymentMode] ?? String(txn.paymentMode ?? '—'),
      };
    });

    return {rows, totalCount: Number(summary.count), totals, totalsByMode};
  }

  /**
   * Wallet top-ups taken for the selected stores, as Mode Of Payment rows.
   *
   * In-store top-ups use the store captured on the recharge request.
   * Customer preferred store remains the fallback for legacy/self-service
   * requests that have no store of their own.
   *
   * Source is WalletRechargeRequest, not the WalletTransaction credit it
   * creates: only the request carries a paymentMode, which is the whole
   * point of this report. Only SUCCESS requests count — pending, failed
   * and cancelled ones are not money collected.
   */
  private async buildWalletTopUpRows(
    storeIds: string[],
    from: Date,
    to: Date,
    selectedIds?: string[],
  ): Promise<ModeOfPaymentRow[]> {
    if (selectedIds && !selectedIds.length) return [];
    // Requests by date first (bounded), then only the customers they
    // actually reference — not every customer who prefers this store,
    // which scales with the store's whole customer base rather than this
    // window.
    const [candidateRequests, stores] = await Promise.all([
      this.walletRechargeRequestRepo.find({
        where: {
          ...(selectedIds ? {id: {inq: selectedIds}} : {}),
          status: PaymentRequestStatus.SUCCESS,
          createdAt: {between: [from, to]},
        } as object,
        order: ['createdAt DESC'],
      }),
      this.storeRepo.find({
        where: {id: {inq: storeIds}} as object,
        fields: {id: true, name: true, code: true} as object,
      }),
    ]);
    if (!candidateRequests.length) return [];

    const candidateCustomerIds = [...new Set(candidateRequests.map(r => r.customerId))];
    const customers = await findInBatches(candidateCustomerIds, batch =>
      this.customerRepo.find({
        where: {id: {inq: batch}} as object,
        fields: {
          id: true,
          firstName: true,
          lastName: true,
          customerCode: true,
          preferredStoreId: true,
        } as object,
      }),
    );
    if (!customers.length) return [];
    const customerById = new Map(customers.map(c => [String(c.id), c]));

    const requests = candidateRequests.filter(request => {
      const customer = customerById.get(String(request.customerId));
      const storeId = request.storeId ?? customer?.preferredStoreId;
      return storeId != null && storeIds.includes(String(storeId));
    });
    if (!requests.length) return [];

    const storeNameById = new Map(
      stores.map(store => [String(store.id), store.name ?? String(store.code ?? '')]),
    );

    return requests.map(request => {
      const customer = customerById.get(String(request.customerId));
      const storeId = request.storeId ?? customer?.preferredStoreId;

      return {
        // Namespaced so a top-up can never collide with a payment
        // transaction id in the merged list.
        id: `wallet-topup:${request.id}`,
        storeName: storeId
          ? (storeNameById.get(String(storeId)) ?? '—')
          : '—',
        date: request.createdAt ?? null,
        // A top-up is tied to no shift and no ticket. The recharge
        // number is deliberately NOT shown: wallet.service numbers
        // requests per customer, so WR000001 recurs across customers
        // and would read like a ticket number that can be looked up.
        shiftClosureNo: '—',
        ticketNo: 'Wallet Recharge',
        invoiceNo: '-',
        // Self-service — no staff member placed this, unlike a ticket payment.
        userName: '—',
        customerNameWithCode: this.formatCustomerNameWithCode(customer),
        amount: Number(request.amount) || 0,
        reimbursement: 0,
        paymentMode: String(request.paymentMode ?? ''),
        paymentModeLabel:
          PAYMENT_MODE_LABELS[request.paymentMode] ?? String(request.paymentMode ?? '—'),
      };
    });
  }

  /**
   * On Account invoice GENERATION events, as Mode Of Payment rows — shown
   * the moment a consolidated invoice is raised, with paymentMode 'On
   * Account' and no money actually collected yet. The eventual real
   * payment against this same invoice (cash/card/UPI/whatever the
   * customer actually pays with) shows up separately, on whichever day
   * it's actually collected — see buildModeOfPayment's own ticketNo
   * override for that row, which shares this one's `On Account -
   * <invoiceNumber>` label so the two read as one story.
   *
   * A consolidated invoice can span more than one store (its linked
   * orders aren't required to share one) — split per store by each
   * linked order's orderTotal, as ShiftController.resolveRevenue() does, so a
   * store-scoped run of this report never shows money belonging to a
   * different store.
   */
  private async buildOnAccountInvoiceRows(
    storeIds: string[],
    from: Date,
    to: Date,
    selectedIds?: string[],
  ): Promise<ModeOfPaymentRow[]> {
    if (selectedIds && !selectedIds.length) return [];
    const invoices = await this.invoiceRepo.find({
      where: {
        ...(selectedIds ? {id: {inq: selectedIds}} : {}),
        status: InvoiceStatus.ISSUED,
        isConsolidated: true,
        createdAt: {between: [from, to]},
      } as object,
      fields: {
        id: true,
        invoiceNumber: true,
        orderId: true,
        generatedBy: true,
        createdAt: true,
      } as object,
    });
    if (!invoices.length) return [];

    const links = await this.invoiceOrderLinkRepo.find({
      where: {invoiceId: {inq: invoices.map(i => i.id)}} as object,
      fields: {invoiceId: true, orderId: true, orderTotal: true} as object,
    });
    if (!links.length) return [];

    const linkedOrders = await this.orderRepo.find({
      where: {id: {inq: links.map(l => l.orderId)}} as object,
      fields: {id: true, storeId: true} as object,
    });
    const storeIdByOrderId = new Map(linkedOrders.map(o => [o.id, o.storeId]));

    // Each invoice's share per store: invoiceId -> (storeId -> summed orderTotal).
    const shareByInvoiceAndStore = new Map<string, Map<string, number>>();
    for (const link of links) {
      const orderStoreId = storeIdByOrderId.get(link.orderId);
      if (!orderStoreId || !storeIds.includes(orderStoreId)) continue;
      const byStore = shareByInvoiceAndStore.get(link.invoiceId) ?? new Map<string, number>();
      byStore.set(orderStoreId, (byStore.get(orderStoreId) ?? 0) + (Number(link.orderTotal) || 0));
      shareByInvoiceAndStore.set(link.invoiceId, byStore);
    }
    if (!shareByInvoiceAndStore.size) return [];

    // Invoice.orderId is the representative order — used here only to
    // resolve which customer this consolidated invoice bills, same
    // precedent as every other single-order read path that falls back
    // to it (see Invoice model's own doc comment).
    const representativeOrderIds = [...new Set(invoices.map(i => i.orderId))];
    const generatedByIds = [...new Set(invoices.map(i => i.generatedBy).filter(Boolean))];
    const [representativeOrders, generators, stores] = await Promise.all([
      this.orderRepo.find({
        where: {id: {inq: representativeOrderIds}} as object,
        fields: {id: true, customerId: true} as object,
      }),
      generatedByIds.length
        ? this.usersRepo.find({
            where: {id: {inq: generatedByIds}} as object,
            fields: {id: true, fullName: true} as object,
          })
        : [],
      this.storeRepo.find({
        where: {id: {inq: storeIds}} as object,
        fields: {id: true, name: true, code: true} as object,
      }),
    ]);
    const customerIdByRepOrderId = new Map(representativeOrders.map(o => [o.id, o.customerId]));
    const customerIds = [...new Set(representativeOrders.map(o => o.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await this.customerRepo.find({
          where: {id: {inq: customerIds}} as object,
          fields: {id: true, firstName: true, lastName: true, customerCode: true} as object,
        })
      : [];
    const customerById = new Map(customers.map(c => [String(c.id), c]));
    const userNameById = new Map(generators.map(u => [String(u.id), u.fullName ?? '—']));
    const storeNameById = new Map(
      stores.map(store => [String(store.id), store.name ?? String(store.code ?? '—')]),
    );

    const rows: ModeOfPaymentRow[] = [];
    for (const invoice of invoices) {
      const byStore = shareByInvoiceAndStore.get(invoice.id);
      if (!byStore) continue;
      const customerId = customerIdByRepOrderId.get(invoice.orderId);
      const customer = customerId ? customerById.get(String(customerId)) : undefined;

      for (const [storeId, share] of byStore) {
        if (share <= 0) continue;
        rows.push({
          // Namespaced per (invoice, store) so a multi-store consolidated
          // invoice's two rows can never collide, and so this can never
          // collide with a payment transaction id in the merged list.
          id: `on-account-invoice:${invoice.id}:${storeId}`,
          storeName: storeNameById.get(storeId) ?? '—',
          date: invoice.createdAt ?? null,
          // Generating an invoice isn't tied to a till/shift session —
          // same '—' convention as a wallet top-up's shiftClosureNo.
          shiftClosureNo: '—',
          ticketNo: `On Account - ${invoice.invoiceNumber}`,
          invoiceNo: invoice.invoiceNumber,
          userName: invoice.generatedBy
            ? (userNameById.get(String(invoice.generatedBy)) ?? '—')
            : '—',
          customerNameWithCode: this.formatCustomerNameWithCode(customer),
          amount: roundRupees(share),
          reimbursement: 0,
          paymentMode: PaymentMode.ON_ACCOUNT,
          paymentModeLabel: PAYMENT_MODE_LABELS[PaymentMode.ON_ACCOUNT],
        });
      }
    }
    return rows;
  }

  /**
   * orderId -> invoiceNumber, for every given order that was billed
   * through a consolidated On Account invoice — used by
   * buildModeOfPayment to relabel that order's own payment row(s) as
   * `On Account - <invoiceNumber>` instead of the order's own number,
   * once the actual payment against that invoice comes in.
   */
  private async mapOnAccountInvoiceNumbers(orderIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!orderIds.length) return result;

    const links = await findInBatches(orderIds, batch =>
      this.invoiceOrderLinkRepo.find({
        where: {orderId: {inq: batch}} as object,
        fields: {invoiceId: true, orderId: true} as object,
      }),
    );
    if (!links.length) return result;

    const invoices = await findInBatches([...new Set(links.map(l => l.invoiceId))], batch =>
      this.invoiceRepo.find({
        where: {
          id: {inq: batch},
          isConsolidated: true,
          status: InvoiceStatus.ISSUED,
        } as object,
        fields: {id: true, invoiceNumber: true} as object,
      }),
    );
    if (!invoices.length) return result;

    const invoiceNumberById = new Map(invoices.map(i => [i.id, i.invoiceNumber]));
    for (const link of links) {
      const invoiceNumber = invoiceNumberById.get(link.invoiceId);
      if (invoiceNumber) result.set(link.orderId, invoiceNumber);
    }
    return result;
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
    const {storeIds} = params;
    if (!storeIds.length) return emptyPaged();

    const resultPage = await this.orderReportPage(params, 'payments');
    if (!resultPage.count) return emptyPaged();
    const orders = resultPage.orders;
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
        const status = resolveOrderPaymentStatus(total, paid, order.status);
        return {order, balanceDue, status, delivery: deliveryStatuses.get(String(order.id)) ?? ''};
      })
;

    const totals = {
      balanceDue: resultPage.balance,
    };

    const rows = enriched.map(({order, balanceDue, status, delivery}) => {
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

    return {rows, totalCount: resultPage.count, totals};
  }

  /** Filter and aggregate the full result in SQL; hydrate/enrich only its page. */
  private async orderReportPage(params: OrderReportParams & {
    paymentStatus?: string; deliveryStatus?: string; customerName?: string; customerLabelId?: string;
  }, kind: 'payments' | 'tickets' | 'onAccount') {
    const extra = kind === 'tickets' ? {status: {nin: TICKET_TERMINAL_STATUSES}}
      : {status: {neq: OrderStatus.CANCELLED}, ...(kind === 'onAccount' ? {isOnAccount: true} : {})};
    const source = this.orderRepo.dataSource;
    const connector = source.connector as unknown as {
      buildWhere(model: string, where: object): {sql: string; params: unknown[]};
      parameterize(query: {sql: string; params: unknown[]}): {sql: string; params: unknown[]};
    };
    const base = connector.buildWhere(this.orderRepo.entityClass.modelName, {...this.orderScopeWhere(params), ...extra});
    const filters: string[] = [];
    const values: unknown[] = [...base.params];
    if (kind === 'tickets') filters.push("delivery <> 'delivered'");
    else if (params.deliveryStatus && params.deliveryStatus !== 'all') {
      filters.push('lower(delivery) = ?'); values.push(params.deliveryStatus);
    }
    if (params.paymentStatus && params.paymentStatus !== 'all') {
      filters.push(params.paymentStatus === 'pending' && kind === 'payments' ? "paymentstatus <> 'paid'" : 'paymentstatus = ?');
      if (!(params.paymentStatus === 'pending' && kind === 'payments')) values.push(params.paymentStatus);
    }
    if (params.customerName?.trim()) {
      filters.push("position(? in lower(customername)) > 0"); values.push(params.customerName.trim().toLowerCase());
    }
    if (params.customerLabelId) {filters.push('labelid = ?::uuid'); values.push(params.customerLabelId);}
    const query = connector.parameterize({sql: `WITH scoped AS MATERIALIZED (
      SELECT * FROM public.orders ${base.sql}
    ), metrics AS (
      SELECT o.id, o.createdat, COALESCE(o.totalamount, 0) AS amount,
        COALESCE(p.paid, 0) AS paid,
        floor((COALESCE(o.totalamount,0) - COALESCE(p.paid,0))*100 + .5)/100 AS balance,
        COALESCE(d.status, '') AS delivery,
        COALESCE(items.quantity,0) AS quantity,
        trim(COALESCE(c.firstname,'') || ' ' || COALESCE(c.lastname,'')) AS customername,
        label.customerlabelid AS labelid,
        CASE WHEN o.status = 'draft' AND COALESCE(p.paid,0) <= 0 THEN 'pending'
          WHEN floor((COALESCE(o.totalamount,0) - COALESCE(p.paid,0))*100 + .5) <= 0 THEN 'paid'
          WHEN COALESCE(p.paid,0) > 0 THEN 'partial' ELSE 'pending' END AS paymentstatus
      FROM scoped o LEFT JOIN public.customer c ON c.id = o.customerid
      LEFT JOIN (SELECT p.orderid, sum(p.amount) AS paid FROM public.payment_transaction p
        JOIN scoped o ON o.id = p.orderid WHERE p.transactiontype <> 'refund' GROUP BY p.orderid) p ON p.orderid = o.id
      LEFT JOIN LATERAL (SELECT d.status FROM public.delivery_order d WHERE d.orderid = o.id
        ORDER BY d.createdat DESC, d.id DESC LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT sum(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS quantity
        FROM public.order_item WHERE orderid = o.id) items ON true
      LEFT JOIN LATERAL (SELECT a.customerlabelid FROM public.customer_label_assignment a
        JOIN public.customer_label l ON l.id = a.customerlabelid
        WHERE a.customerid = o.customerid ORDER BY a.createdat ASC, a.id ASC LIMIT 1) label ON true
    ), matching AS MATERIALIZED (SELECT * FROM metrics WHERE ${filters.join(' AND ') || 'TRUE'})
    SELECT count(*)::int AS count, COALESCE(sum(amount),0) AS amount, COALESCE(sum(paid),0) AS paid,
      COALESCE(sum(balance),0) AS balance, COALESCE(sum(quantity),0) AS quantity,
      ARRAY(SELECT id FROM matching ORDER BY createdat DESC, id DESC LIMIT ? OFFSET ?) AS ids FROM matching`,
      params: [...values, params.limit, params.skip]});
    const result = await source.execute(query.sql, query.params);
    const row = result[0];
    const ids: string[] = row.ids ?? [];
    const found = ids.length ? await this.orderRepo.find({where: {id: {inq: ids}}}) : [];
    const byId = new Map(found.map(order => [order.id, order]));
    return {orders: ids.map(id => byId.get(id)!).filter(Boolean), count: Number(row.count),
      amount: Number(row.amount), paid: Number(row.paid), balance: Number(row.balance), quantity: Number(row.quantity)};
  }

  /** Pending Tickets — orders still in the plant, not yet delivered. */
  async buildPendingTickets(params: OrderReportParams): Promise<PagedReport<object>> {
    const {storeIds} = params;
    if (!storeIds.length) return emptyPaged();

    const resultPage = await this.orderReportPage(params, 'tickets');
    if (!resultPage.count) return emptyPaged();
    const orders = resultPage.orders;
    const orderIds = orders.map(o => o.id);
    const [orderItems, deliveryStatuses, storeCtx, customerCtx] = await Promise.all([
      this.orderItemRepo.find({
        where: {orderId: {inq: orderIds}} as object,
        fields: {id: true, orderId: true, itemId: true, quantity: true} as object,
        order: ['createdAt ASC', 'id ASC'],
      }),
      this.buildDeliveryStatusByOrder(orderIds),
      this.buildStoreContext(storeIds),
      this.buildCustomerContext([...new Set(orders.map(o => String(o.customerId)))]),
    ]);
    const itemCounts = new Map<string, number>();
    for (const orderItem of orderItems) {
      const quantity = Number(orderItem.quantity) || 0;
      if (quantity <= 0) continue;
      const orderId = String(orderItem.orderId);
      itemCounts.set(orderId, (itemCounts.get(orderId) ?? 0) + quantity);
    }

    // An order already handed over is no longer pending, whatever its
    // own status says.
    const pending = orders.filter(
      o => (deliveryStatuses.get(String(o.id)) ?? '').toLowerCase() !== 'delivered',
    );

    const totals = {
      amount: resultPage.amount,
      items: resultPage.quantity,
    };

    const pageOrders = pending;
    const pageOrderIds = new Set(pageOrders.map(o => String(o.id)));
    const pageItems = orderItems.filter(oi => pageOrderIds.has(String(oi.orderId)));
    const itemIds = [...new Set(pageItems.map(oi => oi.itemId))];
    const items = itemIds.length
      ? await this.itemRepo.find({
          where: {id: {inq: itemIds}} as object,
          fields: {id: true, name: true} as object,
        })
      : [];
    const itemNameById = new Map(items.map(item => [String(item.id), item.name]));
    const itemsByOrder = new Map<string, Array<{name: string; quantity: number}>>();
    for (const orderItem of pageItems) {
      const quantity = Number(orderItem.quantity) || 0;
      if (quantity <= 0) continue;
      const orderId = String(orderItem.orderId);
      if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
      itemsByOrder.get(orderId)!.push({
        name: itemNameById.get(String(orderItem.itemId)) ?? '—',
        quantity,
      });
    }

    const rows = pageOrders.map(order => {
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
        items: itemsByOrder.get(String(order.id)) ?? [],
        receptionDate: order.createdAt ?? null,
        estDeliveryDate: order.deliveryDate ?? null,
        ticketStatus: order.status ?? '—',
        deliveryStatus: deliveryStatuses.get(String(order.id)) ?? '—',
        amount: Number(order.totalAmount) || 0,
      };
    });

    return {rows, totalCount: resultPage.count, totals};
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
    const {storeIds} = params;
    if (!storeIds.length) return emptyPaged();

    const resultPage = await this.orderReportPage(params, 'onAccount');
    if (!resultPage.count) return emptyPaged();
    const orders = resultPage.orders;
    const orderIds = orders.map(o => o.id);
    const [collected, deliveryStatuses, deliveredAt, itemCounts, storeCtx, customerCtx] =
      await Promise.all([
        this.buildCollectedByOrder(orderIds),
        this.buildDeliveryStatusByOrder(orderIds),
        this.buildDeliveredAtByOrder(orderIds),
        this.buildItemCountByOrder(orderIds),
        this.buildStoreContext(storeIds),
        this.buildCustomerContext([...new Set(orders.map(o => String(o.customerId)))]),
      ]);


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
          status: resolveOrderPaymentStatus(total, paid, order.status),
          delivery: deliveryStatuses.get(String(order.id)) ?? '',
        };
      })
;

    const totals = {
      totalAmount: resultPage.amount,
      collected: resultPage.paid,
      balanceDue: resultPage.balance,
    };

    const rows = enriched.map(e => {
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
        itemCount: itemCounts.get(String(e.order.id)) ?? 0,
        receptionDate: e.order.createdAt ?? null,
        estDeliveryDate: e.order.deliveryDate ?? null,
        // Actual hand-over, as opposed to the estimate above; null until
        // the order has genuinely been delivered.
        actDeliveryDate: deliveredAt.get(String(e.order.id)) ?? null,
        orderDate: e.order.createdAt ?? null,
        deliveryStatus: e.delivery || '—',
        paymentMode: PAYMENT_MODE_LABELS[PaymentMode.ON_ACCOUNT],
        paymentStatus: e.status,
        amount: e.total,
        totalAmount: e.total,
        collected: e.paid,
        balanceDue: e.balanceDue,
      };
    });

    return {rows, totalCount: resultPage.count, totals};
  }

  /**
   * Sales Report of GST — one row per issued invoice.
   *
   * Keyed by invoice generation date, same as Revenue elsewhere in this
   * file — a ticket only has something taxable to report once it's
   * actually invoiced.
   *
   */
  async buildSalesGst(params: OrderReportParams & {state?: string}): Promise<PagedReport<object>> {
    const {storeIds, state, from, to, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const selectedStoreIds = state
      ? (await this.storeRepo.find({
          where: {id: {inq: storeIds}, state} as object,
          fields: {id: true} as object,
        })).map(store => store.id)
      : storeIds;
    if (!selectedStoreIds.length) return emptyPaged();

    // Invoices in the window first (bounded by date), then only the orders
    // they actually reference — not every order the store(s) have ever
    // raised, which scales with the store's whole history rather than this
    // window and, selected across many/all stores, can approach the full
    // orders table.
    const candidateInvoices = await this.invoiceRepo.find({
      where: {
        status: InvoiceStatus.ISSUED,
        createdAt: {between: [from, to]},
      } as object,
    });
    if (!candidateInvoices.length) return emptyPaged();

    const consolidatedInvoiceIds = candidateInvoices
      .filter(invoice => invoice.isConsolidated)
      .map(invoice => invoice.id);
    const consolidatedLinks = consolidatedInvoiceIds.length
      ? await this.invoiceOrderLinkRepo.find({
          where: {invoiceId: {inq: consolidatedInvoiceIds}} as object,
          fields: {invoiceId: true, orderId: true, orderTotal: true} as object,
        })
      : [];
    const consolidatedOrders = await findInBatches(
      [...new Set(consolidatedLinks.map(link => link.orderId))],
      batch => this.orderRepo.find({
        where: {id: {inq: batch}} as object,
        fields: {id: true, storeId: true} as object,
      }),
    );
    const consolidatedStoreByOrderId = new Map(
      consolidatedOrders.map(order => [String(order.id), String(order.storeId)]),
    );
    const linkedStoresByInvoice = new Map<string, Set<string>>();
    for (const link of consolidatedLinks) {
      const storeId = consolidatedStoreByOrderId.get(String(link.orderId));
      if (!storeId) continue;
      const linkedStores = linkedStoresByInvoice.get(String(link.invoiceId)) ?? new Set<string>();
      linkedStores.add(storeId);
      linkedStoresByInvoice.set(String(link.invoiceId), linkedStores);
    }
    const selectedStoreSet = new Set(selectedStoreIds.map(String));
    const scopedCandidateInvoices = candidateInvoices.filter(invoice => {
      if (!invoice.isConsolidated) return true;
      const linkedStores = linkedStoresByInvoice.get(String(invoice.id));
      return linkedStores != null && [...linkedStores].every(storeId => selectedStoreSet.has(storeId));
    });

    const candidateOrderIds = [...new Set(scopedCandidateInvoices.map(inv => inv.orderId))];
    const orders = await findInBatches(candidateOrderIds, batch =>
      this.orderRepo.find({
        where: {id: {inq: batch}, storeId: {inq: selectedStoreIds}} as object,
        fields: {
          id: true,
          storeId: true,
          customerId: true,
          orderNumber: true,
          deliveryAddressId: true,
        } as object,
      }),
    );
    if (!orders.length) return emptyPaged();
    const orderById = new Map(orders.map(o => [String(o.id), o]));

    const invoices = scopedCandidateInvoices.filter(invoice => orderById.has(String(invoice.orderId)));
    if (!invoices.length) return emptyPaged();

    const invoiceIdSet = new Set(invoices.map(invoice => String(invoice.id)));
    const consolidatedOrderIds = [...new Set(consolidatedLinks
      .filter(link => invoiceIdSet.has(String(link.invoiceId)))
      .map(link => link.orderId))];
    const consolidatedOrderItems = await findInBatches(consolidatedOrderIds, batch =>
      this.orderItemRepo.find({
        where: {orderId: {inq: batch}} as object,
        fields: {orderId: true, itemId: true, totalPrice: true} as object,
      }),
    );
    const invoiceItemIds = invoices.flatMap(invoice =>
      (invoice.items ?? []).map(item => String((item as {itemId?: string}).itemId ?? '')).filter(Boolean),
    );
    const itemIds = [...new Set([
      ...invoiceItemIds,
      ...consolidatedOrderItems.map(item => String(item.itemId)),
    ])];
    const catalogItems = await findInBatches(itemIds, batch =>
      this.itemRepo.find({
        where: {id: {inq: batch}} as object,
        fields: {id: true, name: true} as object,
      }),
    );
    const itemNameById = new Map(catalogItems.map(item => [String(item.id), item.name]));
    const itemLinesByOrder = new Map<string, {itemId: string; totalPrice: number}[]>();
    const orderIdsByInvoice = new Map<string, string[]>();
    for (const link of consolidatedLinks) {
      orderIdsByInvoice.set(String(link.invoiceId), [
        ...(orderIdsByInvoice.get(String(link.invoiceId)) ?? []),
        String(link.orderId),
      ]);
    }
    for (const item of consolidatedOrderItems) {
      itemLinesByOrder.set(String(item.orderId), [
        ...(itemLinesByOrder.get(String(item.orderId)) ?? []),
        {itemId: String(item.itemId), totalPrice: Number(item.totalPrice) || 0},
      ]);
    }

    const customerIds = [...new Set(orders.map(o => String(o.customerId)))];
    const addressIds = [...new Set(orders.map(o => o.deliveryAddressId).filter(Boolean))] as string[];

    const [gstConfig, storeCtx, customers, addresses, defaultAddresses] = await Promise.all([
      this.gstTaxConfigurationRepo.findOne({
        where: {isActive: true, isDeleted: false} as object,
      }),
      this.buildStoreContext(selectedStoreIds),
      this.customerRepo.find({where: {id: {inq: customerIds}} as object}),
      addressIds.length
        ? this.customerAddressRepo.find({where: {id: {inq: addressIds}} as object})
        : Promise.resolve([]),
      this.customerAddressRepo.find({
        where: {customerId: {inq: customerIds}, isDefault: true} as object,
      }),
    ]);
    const cgstRatePct = Number(gstConfig?.cgstPercentage) || 0;
    const sgstRatePct = Number(gstConfig?.sgstPercentage) || 0;
    const customerById = new Map(customers.map(c => [String(c.id), c]));
    const addressById = new Map(addresses.map(a => [String(a.id), a]));
    const defaultAddressByCustomer = new Map(defaultAddresses.map(a => [String(a.customerId), a]));

    const legacyConsolidatedIds = invoices
      .filter(invoice => invoice.isConsolidated &&
        (Number(invoice.cgst) || 0) + (Number(invoice.sgst) || 0) === 0)
      .map(invoice => invoice.id);
    const legacyConsolidatedIdSet = new Set(legacyConsolidatedIds.map(String));
    const legacyLinks = consolidatedLinks.filter(link =>
      legacyConsolidatedIdSet.has(String(link.invoiceId)),
    );
    const legacyOrders = await findInBatches(
      [...new Set(legacyLinks.map(link => link.orderId))],
      batch => this.orderRepo.find({
        where: {id: {inq: batch}} as object,
        fields: {
          id: true, subtotal: true, discountAmount: true, taxAmount: true, totalAmount: true,
        } as object,
      }),
    );
    const legacyOrderIds = legacyOrders.map(order => order.id);
    const legacyReturns = await findInBatches(legacyOrderIds, batch =>
      this.salesReturnRepo.find({
        where: {
          orderId: {inq: batch},
          status: SalesReturnStatus.APPROVED,
        } as object,
        fields: {
          orderId: true, creditAmount: true, returnedItems: true,
          resolvedAt: true, updatedAt: true, createdAt: true,
        } as object,
      }),
    );
    const legacyPayments = await findInBatches(legacyOrderIds, batch =>
      this.paymentTransactionRepo.find({
        where: {
          orderId: {inq: batch},
          transactionType: {neq: 'refund'},
        } as object,
        fields: {orderId: true, amount: true, paymentDate: true} as object,
      }),
    );
    const legacyOrderById = new Map(legacyOrders.map(order => [String(order.id), order]));
    const legacyInvoiceById = new Map(invoices.map(invoice => [String(invoice.id), invoice]));
    const legacyReturnsByOrderId = new Map<string, typeof legacyReturns>();
    const legacyPaymentsByOrderId = new Map<string, typeof legacyPayments>();
    for (const salesReturn of legacyReturns) {
      legacyReturnsByOrderId.set(
        String(salesReturn.orderId),
        [...(legacyReturnsByOrderId.get(String(salesReturn.orderId)) ?? []), salesReturn],
      );
    }
    for (const payment of legacyPayments) {
      legacyPaymentsByOrderId.set(
        String(payment.orderId),
        [...(legacyPaymentsByOrderId.get(String(payment.orderId)) ?? []), payment],
      );
    }
    const legacyGstByInvoice = new Map<string, {taxable: number; tax: number}>();
    for (const link of legacyLinks) {
      const linkedOrder = legacyOrderById.get(String(link.orderId));
      if (!linkedOrder) continue;
      const invoice = legacyInvoiceById.get(String(link.invoiceId));
      const invoiceTime = invoice?.createdAt ? new Date(invoice.createdAt).getTime() : -Infinity;
      const laterReturns = (legacyReturnsByOrderId.get(String(link.orderId)) ?? [])
        .filter(salesReturn => {
          const resolvedAt = salesReturn.resolvedAt ?? salesReturn.updatedAt ?? salesReturn.createdAt;
          return resolvedAt && new Date(resolvedAt).getTime() > invoiceTime;
        });
      const returnedGross = laterReturns.reduce(
        (sum, salesReturn) => sum + (Number(salesReturn.creditAmount) || 0),
        0,
      );
      const returnedTax = laterReturns.reduce((sum, salesReturn) => {
        const credit = Number(salesReturn.creditAmount) || 0;
        const items = salesReturn.returnedItems ?? [];
        const itemTax = items.reduce(
          (itemSum, item) => itemSum + (Number((item as {taxAmount?: number}).taxAmount) || 0),
          0,
        );
        const hasItemTax = items.length > 0 && items.every(item =>
          Object.prototype.hasOwnProperty.call(item, 'taxAmount'),
        );
        const preTax = items.reduce(
          (itemSum, item) => itemSum + (Number((item as {amount?: number}).amount) || 0),
          0,
        );
        return sum + (hasItemTax ? itemTax : credit - preTax);
      }, 0);
      const returnedTaxable = returnedGross - returnedTax;
      const orderTotal = (Number(linkedOrder.totalAmount) || 0) + returnedGross;
      const paidBeforeInvoice = (legacyPaymentsByOrderId.get(String(link.orderId)) ?? [])
        .filter(payment => !payment.paymentDate || new Date(payment.paymentDate).getTime() <= invoiceTime)
        .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      const billedTotal = Math.max(0, orderTotal - paidBeforeInvoice);
      const fraction = orderTotal > 0 ? Math.min(1, billedTotal / orderTotal) : 0;
      const current = legacyGstByInvoice.get(String(link.invoiceId)) ?? {taxable: 0, tax: 0};
      current.taxable += (Math.max(
        0,
        (Number(linkedOrder.subtotal) || 0) - (Number(linkedOrder.discountAmount) || 0),
      ) + returnedTaxable) * fraction;
      current.tax += ((Number(linkedOrder.taxAmount) || 0) + returnedTax) * fraction;
      legacyGstByInvoice.set(String(link.invoiceId), current);
    }

    const allRows: object[] = [];
    let srNo = 0;
    for (const invoice of invoices) {
      const order = orderById.get(invoice.orderId);
      if (!order) continue;
      const store = storeCtx.get(String(order.storeId));
      const customer = customerById.get(String(order.customerId));
      const legacyGst = legacyGstByInvoice.get(String(invoice.id));
      const invoiceSubtotal = Number(invoice.subtotal) || 0;
      const taxableSubtotal = legacyGst
        ? roundRupees(legacyGst.taxable)
        : Math.max(0, invoiceSubtotal - (Number(invoice.discount) || 0));
      const storedCgst = Number(invoice.cgst) || 0;
      const storedSgst = Number(invoice.sgst) || 0;
      const invoiceCgst = legacyGst ? roundRupees(legacyGst.tax / 2) : storedCgst;
      const invoiceSgst = legacyGst ? roundRupees(legacyGst.tax - invoiceCgst) : storedSgst;
      const address =
        (order.deliveryAddressId ? addressById.get(order.deliveryAddressId) : undefined) ??
        defaultAddressByCustomer.get(String(order.customerId));
      const customerName = customer?.companyName ??
        [customer?.firstName, customer?.lastName].filter(Boolean).join(' ');
      const linkedOrderIds = invoice.isConsolidated
        ? orderIdsByInvoice.get(String(invoice.id)) ?? []
        : [];
      const itemLines = invoice.isConsolidated
        ? linkedOrderIds.flatMap(orderId => itemLinesByOrder.get(orderId) ?? [])
        : (invoice.items ?? [])
          .map(item => ({
            itemId: String((item as {itemId?: string}).itemId ?? ''),
            totalPrice: Number((item as {totalPrice?: number}).totalPrice) || 0,
          }))
          .filter(item => item.itemId);
      const reportItemLines = itemLines.length ? itemLines : [{itemId: '', totalPrice: 0}];

      reportItemLines.forEach((itemLine, index) => {
        const isFirstItem = index === 0;
        const itemName = itemNameById.get(itemLine.itemId) ?? '—';
        srNo += 1;
        allRows.push({
          id: `${invoice.id}-${index}`,
          isFirstItem,
          srNo,
          bu: BUSINESS_UNIT,
          region: store?.regionName ?? '—',
          cluster: store?.clusterName ?? '—',
          storeName: store?.name ?? '—',
          state: store?.state ?? '—',
          customerGstin: customer?.gstNumber ?? '',
          customerName: customerName || '—',
          invoiceNo: invoice.invoiceNumber ?? '—',
          invoiceDate: invoice.createdAt ?? null,
          invoiceValue: isFirstItem ? roundRupees(Number(invoice.totalAmount) || 0) : 0,
          itemName,
          description: itemName,
          sacHsn: SALES_GST_SAC_CODE,
          taxableValue: isFirstItem ? roundRupees(taxableSubtotal) : 0,
          totalTax: isFirstItem ? roundRupees(invoiceCgst + invoiceSgst) : 0,
          cgstRate: cgstRatePct,
          cgstAmount: isFirstItem ? roundRupees(invoiceCgst) : 0,
          sgstRate: sgstRatePct,
          sgstAmount: isFirstItem ? roundRupees(invoiceSgst) : 0,
          sellerGstin: SALES_GST_SELLER.gstin,
          sellerLegalName: SALES_GST_SELLER.legalName,
          sellerAddr1: SALES_GST_SELLER.addr1,
          sellerAddr2: SALES_GST_SELLER.addr2,
          sellerLocationName: SALES_GST_SELLER.locationName,
          sellerPincode: SALES_GST_SELLER.pincode,
          sellerStateCode: SALES_GST_SELLER.stateCode,
          buyerAddr1: address?.addressLine1 ?? '—',
          buyerAddr2: address?.addressLine2 ?? '—',
          buyerLocationName: address?.city ?? '—',
          buyerPincode: address?.pincode ?? '—',
          buyerStateCode: resolveBuyerStateCode(customer?.gstNumber, address?.state),
        });
      });
    }

    const totals = {
      taxableValue: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {taxableValue: number}).taxableValue || 0), 0),
      ),
      totalTax: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {totalTax: number}).totalTax || 0), 0),
      ),
      invoiceValue: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {invoiceValue: number}).invoiceValue || 0), 0),
      ),
    };

    return {
      rows: allRows.slice(skip, skip + limit),
      totalCount: allRows.length,
      totals,
    };
  }

  /**
   * Daily Sales — one row per closed shift per store per
   * day, with the operator-entered closing collections.
   *
   * Only CLOSED shifts appear: an open shift has no closing form yet, so
   * it has no reconciled collections to report.
   *
   * Named "Daily Sales" (not "Consolidated Daily Sales" — that name is
   * reserved for a different, not-yet-built report) — see
   * scripts/rename-daily-sales-permission.cjs for the permission-string
   * migration that went with this rename.
   */
  /**
   * Daily Sales — one row per (store, closure day), matching
   * the Pulse spec's own example (multiple closure numbers/remarks joined
   * into one row when a store had more than one shift that day).
   *
   * Revenue/discount/tickets/items/services and the sales-return figures
   * come straight off Shift.closing (already computed by
   * ShiftController.close() at closure time via resolveRevenue()/
   * resolveSalesReturn()). DSR tax is revenue less discount multiplied by
   * the active CGST + SGST rate; total sales is that value plus tax, rounded
   * to the nearest rupee.
   *
   * PSB vs P2D is split by invoice generation date and linked order type.
   * The total Revenue column comes from the saved closure snapshot, which
   * also includes returns approved in this shift on earlier invoices.
   *
   * "Other Payment Mode" is the other figure the stored snapshot can't
   * answer — Shift.closing.collections only ever buckets cash/card/UPI/
   * cheque/pgLink/wallet/ppVoucher, so a net banking, bank transfer, PDC
   * or pay-later payment is invisible to it. Summed here from the actual
   * PaymentTransaction rows for each shift's orders instead.
   */
  async buildDailySales(params: {
    storeIds: string[];
    from: Date;
    to: Date;
  }): Promise<PagedReport<object>> {
    const {storeIds, from, to} = params;
    if (!storeIds.length) return emptyPaged();

    const [shifts, storeCtx, monthlyTargets, gstConfig] = await Promise.all([
      this.shiftRepo.find({
        where: {
          storeId: {inq: storeIds},
          status: ShiftStatus.CLOSED,
          closedAt: {between: [from, to]},
        } as object,
        order: ['closedAt ASC'],
      }),
      this.buildStoreContext(storeIds),
      this.storeMonthlyTargetRepo.find({
        where: {
          storeId: {inq: storeIds},
          year: {between: [from.getFullYear(), to.getFullYear()]},
          isDeleted: false,
        } as object,
      }),
      this.gstTaxConfigurationRepo?.findOne({
        where: {isActive: true, isDeleted: false} as object,
      }),
    ]);
    if (!shifts.length) return emptyPaged();
    const gstRate = gstConfig
      ? (Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage)) / 100
      : 0.18;

    // Per-day target = that month's revenueTarget / days in that month
    // (e.g. a ₹31,000 January target -> ₹1,000/day). Keyed by storeId so
    // the lookup below only needs the row's own date to resolve it.
    const targetPerDay = new Map<string, number>();
    for (const target of monthlyTargets) {
      if (target.revenueTarget == null) continue;
      const daysInMonth = new Date(target.year, target.month, 0).getDate();
      targetPerDay.set(
        `${target.storeId}|${target.year}|${target.month}`,
        Number(target.revenueTarget) / daysInMonth,
      );
    }
    const resolveTargetRevenue = (storeId: string, date: Date): number | null => {
      const key = `${storeId}|${date.getFullYear()}|${date.getMonth() + 1}`;
      return targetPerDay.has(key) ? targetPerDay.get(key)! : null;
    };

    // One order/payment fetch for every shift in the page, instead of one
    // pair of queries per shift — then sliced in memory per shift window
    // below. Shifts at a store never overlap, so a plain createdAt/
    // paymentDate range check against each shift's own [openedAt,
    // closedAt] is exact, not an approximation.
    const earliestOpen = shifts.reduce(
      (min, s) => (s.openedAt && s.openedAt < min ? s.openedAt : min),
      shifts[0].openedAt,
    );
    const latestClose = shifts.reduce(
      (max, s) => (s.closedAt && s.closedAt > max ? s.closedAt : max),
      shifts[0].closedAt ?? to,
    );

    const orders = await this.orderRepo.find({
      where: {
        storeId: {inq: storeIds},
        createdAt: {between: [earliestOpen, latestClose]},
        status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED]},
      } as object,
      fields: {
        id: true,
        storeId: true,
        orderType: true,
        subtotal: true,
        createdAt: true,
      } as object,
    });

    // A month across every store is tens of thousands of orders — chunk
    // each id lookup (see findInBatches) rather than one oversized IN list.
    const orderIds = orders.map(o => o.id);
    const payments = orderIds.length
      ? await findInBatches(orderIds, ids => this.paymentTransactionRepo.find({
          where: {
            orderId: {inq: ids},
            paymentDate: {between: [earliestOpen, latestClose]},
          } as object,
          fields: {
            orderId: true,
            paymentMode: true,
            amount: true,
            transactionType: true,
            paymentDate: true,
            transactionReference: true,
          } as object,
        }))
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    // PSB/P2D uses the same invoice-order values as ShiftController.
    // A separate fetch from `orders`/`payments` above
    // because the order set differs: an order created (and paid) weeks ago
    // but invoiced inside this window belongs here even though its
    // createdAt falls outside [earliestOpen, latestClose].
    const revenueInvoices = await this.invoiceRepo.find({
      where: {
        status: InvoiceStatus.ISSUED,
        createdAt: {between: [earliestOpen, latestClose]},
      } as object,
      fields: {
        id: true,
        orderId: true,
        subtotal: true,
        discount: true,
        cgst: true,
        sgst: true,
        totalAmount: true,
        isConsolidated: true,
        createdAt: true,
      } as object,
    });
    const revenueInvoiceById = new Map(revenueInvoices.map(invoice => [invoice.id, invoice]));
    const revenueLinks = revenueInvoices.length
      ? await findInBatches(revenueInvoices.map(invoice => invoice.id), ids => this.invoiceOrderLinkRepo.find({
          where: {invoiceId: {inq: ids}} as object,
          fields: {invoiceId: true, orderId: true, orderTotal: true} as object,
        }))
      : [];
    const linkedInvoiceIds = new Set(revenueLinks.map(link => link.invoiceId));
    const invoiceOrders = [
      ...revenueLinks,
      ...revenueInvoices
        .filter(invoice => !invoice.isConsolidated && !linkedInvoiceIds.has(invoice.id))
        .map(invoice => ({
          invoiceId: invoice.id,
          orderId: invoice.orderId,
          orderTotal: invoice.totalAmount,
        })),
    ];
    const revenueOrderIds = [...new Set(invoiceOrders.map(link => link.orderId))];
    const revenueOrders = await findInBatches(revenueOrderIds, batch =>
      this.orderRepo.find({
        where: {
          id: {inq: batch},
          storeId: {inq: storeIds},
          status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED]},
        } as object,
        fields: {
          id: true, storeId: true, orderType: true, status: true,
          taxAmount: true, totalAmount: true,
        } as object,
      }),
    );
    const revenueOrderById = new Map(revenueOrders.map(o => [o.id, o]));
    const approvedReturns = await findInBatches(revenueOrderIds, batch =>
      this.salesReturnRepo.find({
        where: {
          orderId: {inq: batch},
          status: SalesReturnStatus.APPROVED,
        } as object,
        fields: {
          orderId: true,
          creditAmount: true,
          returnedItems: true,
          resolvedAt: true,
          updatedAt: true,
          createdAt: true,
        } as object,
      }),
    );
    const returnsByOrderId = new Map<string, typeof approvedReturns>();
    for (const salesReturn of approvedReturns) {
      returnsByOrderId.set(
        salesReturn.orderId,
        [...(returnsByOrderId.get(salesReturn.orderId) ?? []), salesReturn],
      );
    }

    const grouped = new Map<string, DailySalesRow>();
    // closureNo/remarks are joined across every shift in a (store, day)
    // group; cumulative-diff figures are running totals, so only the
    // LAST shift closed that day carries the up-to-date number.
    const closureNumbers = new Map<string, string[]>();
    const openRemarks = new Map<string, string[]>();
    const closeRemarks = new Map<string, string[]>();

    for (const shift of shifts) {
      if (!shift.closedAt) continue;
      const day = toDateKey(new Date(shift.closedAt));
      const key = `${day}|${shift.storeId}`;
      const closing = (shift.closing ?? {}) as ShiftClosingSnapshot;
      const collections = closing.collections ?? {};
      const walletCollections = closing.walletCollections ?? {};
      const revenueCell = closing.revenue?.pressto ?? {};
      const returnCell = closing.salesReturn?.pressto ?? {};

      const windowStart = shift.openedAt.getTime();
      const windowEnd = shift.closedAt.getTime();

      const isMigratedItpvShift = closing.itpv?.zReport != null;
      const usesStoredItpvSplit =
        isMigratedItpvShift && day >= ITPV_PZ_SPLIT_EFFECTIVE_DATE;
      let psbRevenue = isMigratedItpvShift
        ? Number(closing.itpv?.zReport?.revenue?.revenue) || 0
        : 0;
      let pmuRevenue = 0;
      let p2dRevenue = usesStoredItpvSplit
        ? Number(closing.itpv?.pReport?.revenue?.revenue) || 0
        : 0;
      for (const link of invoiceOrders) {
        const order = revenueOrderById.get(link.orderId);
        if (!order || order.storeId !== shift.storeId) continue;
        const invoice = revenueInvoiceById.get(link.invoiceId);
        if (!invoice) continue;
        // Every invoice linked to this order falls somewhere in
        // [earliestOpen, latestClose] already (that's how revenueInvoices
        // was fetched) — still need its own createdAt to know which
        // specific shift's window it lands in, same as the store check above.
        const invoiceCreatedAt = invoice.createdAt ? new Date(invoice.createdAt).getTime() : null;
        if (invoiceCreatedAt == null || invoiceCreatedAt < windowStart || invoiceCreatedAt > windowEnd) continue;
        if (usesStoredItpvSplit) continue;

        const orderTotal = Number(link.orderTotal) || 0;
        const laterReturns = (returnsByOrderId.get(link.orderId) ?? []).filter(salesReturn => {
          const resolvedAt = salesReturn.resolvedAt ?? salesReturn.updatedAt ?? salesReturn.createdAt;
          return resolvedAt && new Date(resolvedAt).getTime() > windowEnd;
        });
        const returnedGross = laterReturns.reduce(
          (sum, salesReturn) => sum + (Number(salesReturn.creditAmount) || 0),
          0,
        );
        const returnedTax = laterReturns.reduce((sum, salesReturn) => {
          const credit = Number(salesReturn.creditAmount) || 0;
          const items = salesReturn.returnedItems ?? [];
          const itemTax = items.reduce(
            (itemSum, item) =>
              itemSum + (Number((item as {taxAmount?: number}).taxAmount) || 0),
            0,
          );
          const hasItemTax = items.length > 0 && items.every(item =>
            Object.prototype.hasOwnProperty.call(item, 'taxAmount'),
          );
          const preTax = items.reduce(
            (itemSum, item) =>
              itemSum + (Number((item as {amount?: number}).amount) || 0),
            0,
          );
          return sum + (hasItemTax ? itemTax : credit - preTax);
        }, 0);
        const invoiceOrderTotal = orderTotal + returnedGross;
        const invoiceOrderTax = Number(order.taxAmount) + returnedTax;
        const invoiceOrderGross = Number(order.totalAmount) + returnedGross;
        const tax = invoice.isConsolidated
          ? invoiceOrderGross
            ? Math.round(invoiceOrderTotal * invoiceOrderTax / invoiceOrderGross * 100) / 100
            : 0
          : (Number(invoice.cgst) || 0) + (Number(invoice.sgst) || 0);
        const value = invoice.isConsolidated
          ? invoiceOrderTotal - tax
          : Number(invoice.subtotal) || 0;
        if (isMigratedItpvShift) {
          if ((Number(returnCell.revenue) || 0) > 0 && order.status === OrderStatus.RETURNED) {
            continue;
          }
          if (order.orderType === OrderType.HOME_PICKUP) pmuRevenue += value;
          else if (order.orderType === OrderType.HOME_PICKUP_HOME_DELIVERY) p2dRevenue += value;
        } else if (P2D_ORDER_TYPES.includes(order.orderType as OrderType)) p2dRevenue += value;
        else if (PSB_ORDER_TYPES.includes(order.orderType as OrderType)) psbRevenue += value;
      }

      let otherPaymentMode = 0;
      let cardOthersAmount = 0;
      for (const payment of payments) {
        if (payment.transactionType === 'refund') continue;
        const order = orderById.get(payment.orderId);
        if (!order || order.storeId !== shift.storeId) continue;
        const paidAt = payment.paymentDate ? new Date(payment.paymentDate).getTime() : null;
        if (paidAt == null || paidAt < windowStart || paidAt > windowEnd) continue;
        const amount = Number(payment.amount) || 0;
        if (OTHER_PAYMENT_MODES.has(String(payment.paymentMode))) {
          otherPaymentMode += amount;
        } else if (
          String(payment.paymentMode) === PaymentMode.CARD &&
          /\bcard\s+others\b/i.test(String(payment.transactionReference ?? ''))
        ) {
          otherPaymentMode += amount;
          cardOthersAmount += amount;
        }
      }

      const row =
        grouped.get(key) ??
        {
          id: key,
          day: new Date(shift.closedAt).toLocaleDateString('en-IN', {weekday: 'long'}),
          date: day,
          closureNo: '',
          storeName: storeCtx.get(String(shift.storeId))?.name ?? '—',
          storeCode: storeCtx.get(String(shift.storeId))?.code ?? '—',
          clusterName: storeCtx.get(String(shift.storeId))?.clusterName ?? '—',
          regionName: storeCtx.get(String(shift.storeId))?.regionName ?? '—',
          psbRevenue: 0,
          pmuRevenue: 0,
          p2dRevenue: 0,
          revenue: 0,
          targetRevenue: resolveTargetRevenue(String(shift.storeId), new Date(shift.closedAt)),
          discount: 0,
          discountedRevenue: 0,
          taxes: 0,
          totalSales: 0,
          noOfTickets: 0,
          noOfItems: 0,
          noOfServices: 0,
          otherPaymentMode: 0,
          ppVouchers: 0,
          cash: 0,
          cardsUpi: 0,
          chequesReceived: 0,
          reimbursed: 0,
          pgLink: 0,
          wallet: 0,
          walletRechargedCash: 0,
          walletRechargedOther: 0,
          totalReceipts: 0,
          supposedBankDeposit: 0,
          actualBankDeposit: 0,
          diffInDeposit: 0,
          noOfSalesReturnServices: 0,
          salesReturnSaleAmount: 0,
          shiftOpenRemark: '',
          shiftClosingRemark: '',
          cumulativeDifference: '—',
        };

      row.psbRevenue += psbRevenue;
      row.pmuRevenue += pmuRevenue;
      row.p2dRevenue += p2dRevenue;
      const revenue = Number(revenueCell.revenue) || 0;
      const discount = Number(revenueCell.discount) || 0;
      row.revenue += revenue;
      row.discount += discount;
      row.noOfTickets += Number(revenueCell.tickets) || 0;
      row.noOfItems += Number(revenueCell.items) || 0;
      row.noOfServices += Number(revenueCell.services) || 0;
      row.otherPaymentMode += otherPaymentMode;
      row.ppVouchers += Number(collections.ppVoucher) || 0;
      row.cash += Number(collections.cash) || 0;
      row.cardsUpi +=
        (Number(collections.card) || 0) + (Number(collections.upi) || 0) - cardOthersAmount;
      row.chequesReceived += Number(collections.cheque) || 0;
      row.reimbursed += Number(closing.register?.reimbursement) || 0;
      row.pgLink += Number(collections.pgLink) || 0;
      row.wallet += Number(collections.wallet) || 0;
      row.walletRechargedCash += Number(walletCollections.cash) || 0;
      row.walletRechargedOther +=
        (Number(walletCollections.card) || 0) +
        (Number(walletCollections.upi) || 0) +
        (Number(walletCollections.netBanking) || 0) +
        (Number(walletCollections.ppVoucher) || 0);
      row.totalReceipts =
        row.otherPaymentMode +
        row.ppVouchers +
        row.cash +
        row.cardsUpi +
        row.chequesReceived +
        row.pgLink +
        row.wallet;
      row.supposedBankDeposit = Number(closing.banking?.supposed) || 0;
      row.actualBankDeposit += Number(closing.banking?.deposited) || 0;
      row.diffInDeposit =
        closing.banking?.inSafe != null
          ? Number(closing.banking.inSafe) || 0
          : row.supposedBankDeposit - row.actualBankDeposit;
      row.noOfSalesReturnServices += Number(returnCell.services) || 0;
      row.salesReturnSaleAmount += Number(returnCell.revenue ?? returnCell.totalSales) || 0;

      const ct = closing.actualCashInTill?.cumulativeDiff ?? 0;
      const pc = closing.pettyCash?.cumulativeDiff ?? 0;
      const pv = closing.ppVoucher?.cumulativeDiff ?? 0;
      const bd = closing.banking?.cumulativeDiff ?? 0;
      row.cumulativeDifference = `CT: ${ct}, PC: ${pc}, PV: ${pv}, BD: ${bd}`;

      const closureLabel =
        shift.closureNo != null ? String(shift.closureNo) : String(shift.openingNo);
      closureNumbers.set(key, [...(closureNumbers.get(key) ?? []), closureLabel]);
      const openRemark = (shift.opening as {remarks?: string} | undefined)?.remarks?.trim();
      if (openRemark) {
        openRemarks.set(key, [
          ...(openRemarks.get(key) ?? []),
          `${closureLabel} - ${openRemark}`,
        ]);
      }
      const closeRemark = closing.remarks?.trim();
      if (closeRemark) {
        closeRemarks.set(key, [
          ...(closeRemarks.get(key) ?? []),
          `${closureLabel} - ${closeRemark}`,
        ]);
      }

      grouped.set(key, row);
    }

    for (const [key, row] of grouped) {
      row.discountedRevenue = Math.round((row.revenue - row.discount) * 100) / 100;
      row.taxes = Math.round(row.discountedRevenue * gstRate * 100) / 100;
      row.totalSales = Math.round(row.revenue - row.discount + row.taxes);
      row.closureNo = (closureNumbers.get(key) ?? []).join(', ');
      row.shiftOpenRemark = (openRemarks.get(key) ?? []).join(', ') || '—';
      row.shiftClosingRemark = (closeRemarks.get(key) ?? []).join(', ') || '—';
    }

    const rows = [...grouped.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.storeName.localeCompare(b.storeName),
    );

    const sum = (fn: (row: DailySalesRow) => number) => rows.reduce((s, r) => s + fn(r), 0);

    return {
      rows,
      totalCount: rows.length,
      totals: {
        psbRevenue: sum(r => r.psbRevenue),
        pmuRevenue: sum(r => r.pmuRevenue),
        p2dRevenue: sum(r => r.p2dRevenue),
        revenue: sum(r => r.revenue),
        targetRevenue: sum(r => r.targetRevenue ?? 0),
        discount: sum(r => r.discount),
        discountedRevenue: sum(r => r.discountedRevenue),
        taxes: sum(r => r.taxes),
        totalSales: sum(r => r.totalSales),
        noOfTickets: sum(r => r.noOfTickets),
        noOfItems: sum(r => r.noOfItems),
        noOfServices: sum(r => r.noOfServices),
        otherPaymentMode: sum(r => r.otherPaymentMode),
        ppVouchers: sum(r => r.ppVouchers),
        cash: sum(r => r.cash),
        cardsUpi: sum(r => r.cardsUpi),
        chequesReceived: sum(r => r.chequesReceived),
        reimbursed: sum(r => r.reimbursed),
        pgLink: sum(r => r.pgLink),
        wallet: sum(r => r.wallet),
        walletRechargedCash: sum(r => r.walletRechargedCash),
        walletRechargedOther: sum(r => r.walletRechargedOther),
        totalReceipts: sum(r => r.totalReceipts),
        supposedBankDeposit: sum(r => r.supposedBankDeposit),
        actualBankDeposit: sum(r => r.actualBankDeposit),
        diffInDeposit: sum(r => r.diffInDeposit),
        noOfSalesReturnServices: sum(r => r.noOfSalesReturnServices),
        salesReturnSaleAmount: sum(r => r.salesReturnSaleAmount),
      },
    };
  }

  /** Petty cash transactions and separate opening/closing events for each shift. */
  async buildPettyCashExpense(params: {
    storeIds: string[];
    from: Date;
    to: Date;
    limit: number;
    skip: number;
  }): Promise<
    PagedReport<object> & {totalsByDescription: Record<string, number>}
  > {
    const {storeIds, from, to, limit, skip} = params;
    if (!storeIds.length) return {...emptyPaged(), totalsByDescription: {}};

    const result = await this.pettyCashRegisterRepo.execute(PETTY_CASH_REPORT_SQL, [storeIds, from, to, limit, skip]);
    const row = result[0];
    return {rows: row.rows.map((entry: {expenseDate?: string}) => ({...entry,
      expenseDate: entry.expenseDate ? new Date(entry.expenseDate) : null})),
      totalCount: Number(row.count), totals: row.totals, totalsByDescription: row.descriptions};
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
      fields: {id: true, name: true, code: true, state: true, clusterId: true} as object,
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
            code: s.code ?? '—',
            state: s.state,
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
      order: ['createdAt DESC', 'id DESC'],
    });
    const byOrder = new Map<string, string>();
    for (const row of rows) {
      if (row.orderId && !byOrder.has(String(row.orderId))) byOrder.set(String(row.orderId), String(row.status ?? ''));
    }
    return byOrder;
  }

  /**
   * When each order actually reached the customer — the "Act Delivery
   * Date" column, as distinct from the estimated date on the order.
   */
  private async buildDeliveredAtByOrder(orderIds: string[]) {
    if (!orderIds.length) return new Map<string, Date | null>();
    const rows = await this.deliveryOrderRepo.find({
      where: {orderId: {inq: orderIds}} as object,
      fields: {orderId: true, arrivedAt: true} as object,
    });
    const byOrder = new Map<string, Date | null>();
    for (const row of rows) {
      if (row.orderId) byOrder.set(String(row.orderId), row.arrivedAt ?? null);
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
  ): Promise<Map<string, {firstName?: string; lastName?: string; customerCode?: string}>> {
    const ids = [
      ...new Set(txns.map(t => orderById.get(t.orderId)?.customerId).filter(Boolean) as string[]),
    ];
    if (!ids.length) return new Map();
    const customers = await this.customerRepo.find({
      where: {id: {inq: ids}} as object,
      fields: {id: true, firstName: true, lastName: true, customerCode: true} as object,
    });
    return new Map(
      customers.map(c => [
        String(c.id),
        {firstName: c.firstName, lastName: c.lastName, customerCode: c.customerCode},
      ]),
    );
  }

  /** "Jane Doe (CUST-00123)", or just the name/code alone if the other is missing. */
  private formatCustomerNameWithCode(
    customer: {firstName?: string; lastName?: string; customerCode?: string} | undefined,
  ): string {
    if (!customer) return '—';
    const name = `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
    const code = customer.customerCode ?? '';
    if (name && code) return `${name} (${code})`;
    return name || code || '—';
  }
}
