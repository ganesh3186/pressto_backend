import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {InvoiceStatus} from '../models/invoice.model';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {PaymentRequestStatus} from '../models/payment-request-status.enum';
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
  PettyCashRegisterEntryRepository,
  RegionRepository,
  ServiceRepository,
  ShiftRepository,
  StoreRepository,
  UsersRepository,
  WalletRechargeRequestRepository,
} from '../repositories';

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
};

export type ModeOfPaymentRow = {
  id: string;
  storeName: string;
  date: Date | null;
  shiftClosureNo: string;
  ticketNo: string;
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
  discount: number;
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
  walletCollections?: {cash?: number; card?: number; upi?: number; netBanking?: number};
  register?: {reimbursement?: number};
  banking?: {supposed?: number; deposited?: number; cumulativeDiff?: number};
  pettyCash?: {cumulativeDiff?: number};
  ppVoucher?: {cumulativeDiff?: number};
  actualCashInTill?: {cumulativeDiff?: number};
};

/** Order types booked as a walk-in/counter sale — the "PSB" revenue bucket. */
const PSB_ORDER_TYPES = [OrderType.STORE_DROPOFF, OrderType.STORE_DROPOFF_HOME_DELIVERY];

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

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
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
    @repository(WalletRechargeRequestRepository)
    private walletRechargeRequestRepo: WalletRechargeRequestRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(InvoiceOrderLinkRepository)
    private invoiceOrderLinkRepo: InvoiceOrderLinkRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
    @repository(CustomerAddressRepository)
    private customerAddressRepo: CustomerAddressRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(GstTaxConfigurationRepository)
    private gstTaxConfigurationRepo: GstTaxConfigurationRepository,
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
   * On Account invoices work the same way, for the same reason — see
   * buildOnAccountInvoiceRows: the invoice GENERATION event shows up as
   * its own row (paymentMode 'On Account', nothing actually collected
   * yet), and the eventual real payment against it shows up later, on
   * whichever day it's actually paid, as a normal payment row — just
   * with its ticket cell overridden to the same `On Account -
   * <invoiceNumber>` label (see the ticketNo override in the main
   * payment-row map below) instead of the underlying order's own number.
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

    // Payments carry no storeId — they reach a store through their order,
    // and an order raised months ago can still be paid inside this
    // window, so the order set deliberately is NOT date-filtered.
    const [orders, walletRows, onAccountInvoiceRows] = await Promise.all([
      this.orderRepo.find({
        where: {storeId: {inq: storeIds}} as object,
        fields: {
          id: true,
          orderNumber: true,
          storeId: true,
          shiftId: true,
          placedByName: true,
          customerId: true,
        } as object,
      }),
      this.buildWalletTopUpRows(storeIds, from, to),
      this.buildOnAccountInvoiceRows(storeIds, from, to),
    ]);

    const orderById = new Map(orders.map(o => [o.id, o]));
    const [payments, onAccountInvoiceNumberByOrderId] = await Promise.all([
      orders.length
        ? this.paymentTransactionRepo.find({
            where: {
              orderId: {inq: orders.map(o => o.id)},
              paymentDate: {between: [from, to]},
            } as object,
            order: ['paymentDate DESC'],
          })
        : [],
      this.mapOnAccountInvoiceNumbers(orders.map(o => o.id)),
    ]);

    if (!payments.length && !walletRows.length && !onAccountInvoiceRows.length) return empty;

    // The three ledgers are paged as one list, so the whole merged set has
    // to be ordered in memory before slicing: a DB-side limit/skip on the
    // payments alone would drop the top-ups/invoices that belong on the
    // same page.
    type Entry =
      | {date: Date | null; payment: (typeof payments)[number]; wallet?: undefined; onAccountInvoice?: undefined}
      | {date: Date | null; wallet: ModeOfPaymentRow; payment?: undefined; onAccountInvoice?: undefined}
      | {date: Date | null; onAccountInvoice: ModeOfPaymentRow; payment?: undefined; wallet?: undefined};

    const entries: Entry[] = [
      ...payments.map(payment => ({date: payment.paymentDate ?? null, payment})),
      ...walletRows.map(wallet => ({date: wallet.date, wallet})),
      ...onAccountInvoiceRows.map(onAccountInvoice => ({date: onAccountInvoice.date, onAccountInvoice})),
    ].sort((a, b) => timeOf(b.date) - timeOf(a.date));

    // Count and totals come from the whole matching set, never just the
    // page — a footer that only summed the visible rows would restate the
    // very bug this endpoint replaces.
    const totalsByMode: Record<string, number> = {};
    const totals = entries.reduce(
      (acc, entry) => {
        if (entry.wallet) {
          acc.amount += entry.wallet.amount;
          const label =
            PAYMENT_MODE_LABELS[entry.wallet.paymentMode] ?? entry.wallet.paymentModeLabel;
          totalsByMode[label] = roundRupees((totalsByMode[label] ?? 0) + entry.wallet.amount);
          return acc;
        }
        if (entry.onAccountInvoice) {
          acc.amount += entry.onAccountInvoice.amount;
          const label =
            PAYMENT_MODE_LABELS[entry.onAccountInvoice.paymentMode] ??
            entry.onAccountInvoice.paymentModeLabel;
          totalsByMode[label] = roundRupees((totalsByMode[label] ?? 0) + entry.onAccountInvoice.amount);
          return acc;
        }
        const txn = entry.payment;
        const value = Number(txn.amount) || 0;
        const label = PAYMENT_MODE_LABELS[txn.paymentMode] ?? String(txn.paymentMode ?? '—');
        if (txn.transactionType === 'refund') {
          acc.reimbursement += value;
        } else {
          acc.amount += value;
          totalsByMode[label] = roundRupees((totalsByMode[label] ?? 0) + value);
        }
        return acc;
      },
      {amount: 0, reimbursement: 0},
    );

    const pageEntries = entries.slice(skip, skip + limit);
    const pagePayments = pageEntries
      .map(entry => entry.payment)
      .filter(Boolean) as typeof payments;

    const [storeById, shiftById, customerById] = await Promise.all([
      this.mapStores(pagePayments, orderById),
      this.mapShifts(pagePayments, orderById),
      this.mapCustomers(pagePayments, orderById),
    ]);

    const rows: ModeOfPaymentRow[] = pageEntries.map(entry => {
      if (entry.wallet) return entry.wallet;
      if (entry.onAccountInvoice) return entry.onAccountInvoice;

      const txn = entry.payment;
      const order = orderById.get(txn.orderId);
      const isRefund = txn.transactionType === 'refund';
      const value = Number(txn.amount) || 0;
      const shift = order?.shiftId ? shiftById.get(String(order.shiftId)) : undefined;
      const customer = order?.customerId ? customerById.get(String(order.customerId)) : undefined;
      // This order was billed through a consolidated On Account invoice —
      // show the same `On Account - <invoiceNumber>` label the billing-
      // event row above used, instead of the order's own number, so the
      // two rows (invoice raised, then eventually paid) read as one
      // story rather than two unrelated-looking lines.
      const onAccountInvoiceNumber = onAccountInvoiceNumberByOrderId.get(txn.orderId);

      return {
        id: String(txn.id),
        storeName: order?.storeId ? (storeById.get(String(order.storeId)) ?? '—') : '—',
        date: txn.paymentDate ?? null,
        // closureNo exists only once a shift has been closed; an open
        // shift has no closure number yet, which is not missing data.
        shiftClosureNo: shift?.closureNo != null ? String(shift.closureNo) : '—',
        ticketNo: onAccountInvoiceNumber
          ? `On Account - ${onAccountInvoiceNumber}`
          : order?.orderNumber ?? '—',
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

    return {rows, totalCount: entries.length, totals, totalsByMode};
  }

  /**
   * Wallet top-ups taken for the selected stores, as Mode Of Payment rows.
   *
   * A top-up has no store of its own — nothing on the recharge request or
   * the wallet records where the money was handed over — so the customer's
   * preferred store is the only link the schema offers, and that is what
   * this matches on. A customer with no preferred store therefore appears
   * under no store at all, which is the honest answer rather than a guess.
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
  ): Promise<ModeOfPaymentRow[]> {
    const customers = await this.customerRepo.find({
      where: {preferredStoreId: {inq: storeIds}} as object,
      fields: {
        id: true,
        firstName: true,
        lastName: true,
        customerCode: true,
        preferredStoreId: true,
      } as object,
    });
    if (!customers.length) return [];

    const customerById = new Map(customers.map(c => [String(c.id), c]));

    const [requests, stores] = await Promise.all([
      this.walletRechargeRequestRepo.find({
        where: {
          customerId: {inq: [...customerById.keys()]},
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
    if (!requests.length) return [];

    const storeNameById = new Map(
      stores.map(store => [String(store.id), store.name ?? String(store.code ?? '')]),
    );

    return requests.map(request => {
      const customer = customerById.get(String(request.customerId));

      return {
        // Namespaced so a top-up can never collide with a payment
        // transaction id in the merged list.
        id: `wallet-topup:${request.id}`,
        storeName: customer?.preferredStoreId
          ? (storeNameById.get(String(customer.preferredStoreId)) ?? '—')
          : '—',
        date: request.createdAt ?? null,
        // A top-up is tied to no shift and no ticket. The recharge
        // number is deliberately NOT shown: wallet.service numbers
        // requests per customer, so WR000001 recurs across customers
        // and would read like a ticket number that can be looked up.
        shiftClosureNo: '—',
        ticketNo: 'Wallet Recharge',
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
   * store's own share of the invoice's total, same proration
   * ShiftController.resolveRevenue() already uses for Revenue, so a
   * store-scoped run of this report never shows money belonging to a
   * different store.
   */
  private async buildOnAccountInvoiceRows(
    storeIds: string[],
    from: Date,
    to: Date,
  ): Promise<ModeOfPaymentRow[]> {
    const invoices = await this.invoiceRepo.find({
      where: {
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

    const links = await this.invoiceOrderLinkRepo.find({
      where: {orderId: {inq: orderIds}} as object,
      fields: {invoiceId: true, orderId: true} as object,
    });
    if (!links.length) return result;

    const invoices = await this.invoiceRepo.find({
      where: {id: {inq: [...new Set(links.map(l => l.invoiceId))]}, isConsolidated: true} as object,
      fields: {id: true, invoiceNumber: true} as object,
    });
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
    const {storeIds, limit, skip} = params;
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
        deliveryStatus: deliveryStatuses.get(String(order.id)) ?? '—',
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
    const [collected, deliveryStatuses, deliveredAt, itemCounts, storeCtx, customerCtx] =
      await Promise.all([
        this.buildCollectedByOrder(orderIds),
        this.buildDeliveryStatusByOrder(orderIds),
        this.buildDeliveredAtByOrder(orderIds),
        this.buildItemCountByOrder(orderIds),
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
        itemCount: itemCounts.get(String(e.order.id)) ?? 0,
        receptionDate: e.order.createdAt ?? null,
        estDeliveryDate: e.order.deliveryDate ?? null,
        // Actual hand-over, as opposed to the estimate above; null until
        // the order has genuinely been delivered.
        actDeliveryDate: deliveredAt.get(String(e.order.id)) ?? null,
        orderDate: e.order.createdAt ?? null,
        deliveryStatus: e.delivery || '—',
        paymentStatus: e.status,
        amount: e.total,
        totalAmount: e.total,
        collected: e.paid,
        balanceDue: e.balanceDue,
      };
    });

    return {rows, totalCount: enriched.length, totals};
  }

  /**
   * Sales Report of GST — one row per INVOICE LINE ITEM, matching the
   * client's own GST sales register format (Sr No / BU / Region / ... /
   * Buyer_State_Code).
   *
   * Keyed by invoice generation date, same as Revenue elsewhere in this
   * file — a ticket only has something taxable to report once it's
   * actually invoiced.
   *
   * Only plain, single-order invoices contribute: a consolidated
   * (On Account) invoice never gets a CGST/SGST split or an item
   * snapshot written to it (see CustomerBillingController.generate...
   * invoice — subtotal is just the combined balance due, tax fields stay
   * at their 0 default), so there is nothing GST-relevant to report for
   * it. This is a real gap in the on-account billing flow, not something
   * this report can paper over — flagged separately, not silently
   * skipped.
   *
   * Each line's Taxable Value/CGST/SGST is that item's proportional
   * share of its invoice's totals (`item.totalPrice ÷ invoice.subtotal`),
   * the same proration technique used for a consolidated invoice's
   * per-order split elsewhere in this file — here applied per-item
   * instead, since the invoice stores only aggregate tax figures, never
   * a per-item breakdown.
   */
  async buildSalesGst(params: OrderReportParams): Promise<PagedReport<object>> {
    const {storeIds, from, to, limit, skip} = params;
    if (!storeIds.length) return emptyPaged();

    const orders = await this.orderRepo.find({
      where: {storeId: {inq: storeIds}} as object,
      fields: {
        id: true,
        storeId: true,
        customerId: true,
        orderNumber: true,
        deliveryAddressId: true,
      } as object,
    });
    if (!orders.length) return emptyPaged();
    const orderById = new Map(orders.map(o => [String(o.id), o]));

    const invoices = await this.invoiceRepo.find({
      where: {
        orderId: {inq: orders.map(o => o.id)},
        status: InvoiceStatus.ISSUED,
        isConsolidated: false,
        createdAt: {between: [from, to]},
      } as object,
    });
    if (!invoices.length) return emptyPaged();

    const customerIds = [...new Set(orders.map(o => String(o.customerId)))];
    const addressIds = [...new Set(orders.map(o => o.deliveryAddressId).filter(Boolean))] as string[];

    const [gstConfig, storeCtx, customers, addresses, defaultAddresses] = await Promise.all([
      this.gstTaxConfigurationRepo.findOne({
        where: {isActive: true, isDeleted: false} as object,
      }),
      this.buildStoreContext(storeIds),
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

    const itemIds = new Set<string>();
    const serviceIds = new Set<string>();
    for (const invoice of invoices) {
      for (const line of (invoice.items ?? []) as Array<{itemId?: string; serviceId?: string}>) {
        if (line.itemId) itemIds.add(line.itemId);
        if (line.serviceId) serviceIds.add(line.serviceId);
      }
    }
    const [items, services] = await Promise.all([
      itemIds.size
        ? this.itemRepo.find({
            where: {id: {inq: [...itemIds]}} as object,
            fields: {id: true, name: true} as object,
          })
        : Promise.resolve([]),
      serviceIds.size
        ? this.serviceRepo.find({
            where: {id: {inq: [...serviceIds]}} as object,
            fields: {id: true, name: true} as object,
          })
        : Promise.resolve([]),
    ]);
    const itemNameById = new Map(items.map(i => [String(i.id), i.name]));
    const serviceNameById = new Map(services.map(s => [String(s.id), s.name]));

    const allRows: object[] = [];
    let srNo = 0;
    for (const invoice of invoices) {
      const order = orderById.get(invoice.orderId);
      if (!order) continue;
      const store = storeCtx.get(String(order.storeId));
      const customer = customerById.get(String(order.customerId));
      const isBusiness = customer?.customerEntityType === 'business';

      const lineItems = (
        (invoice.items ?? []) as Array<{
          itemId?: string;
          serviceId?: string;
          totalPrice?: number;
        }>
      ).filter(line => (Number(line.totalPrice) || 0) > 0);
      if (!lineItems.length) continue;

      const invoiceSubtotal = Number(invoice.subtotal) || 0;
      const taxableSubtotal = Math.max(0, invoiceSubtotal - (Number(invoice.discount) || 0));
      const invoiceCgst = Number(invoice.cgst) || 0;
      const invoiceSgst = Number(invoice.sgst) || 0;

      const address =
        (order.deliveryAddressId ? addressById.get(order.deliveryAddressId) : undefined) ??
        defaultAddressByCustomer.get(String(order.customerId));
      const customerName = isBusiness
        ? customer?.companyName ?? [customer?.firstName, customer?.lastName].filter(Boolean).join(' ')
        : [customer?.firstName, customer?.lastName].filter(Boolean).join(' ');

      for (const line of lineItems) {
        const fraction = invoiceSubtotal > 0 ? (Number(line.totalPrice) || 0) / invoiceSubtotal : 0;
        const taxableValue = roundRupees(taxableSubtotal * fraction);
        const cgstAmount = roundRupees(invoiceCgst * fraction);
        const sgstAmount = roundRupees(invoiceSgst * fraction);
        const totalTax = roundRupees(cgstAmount + sgstAmount);
        const itemName = line.itemId ? itemNameById.get(line.itemId) : undefined;
        const serviceName = line.serviceId ? serviceNameById.get(line.serviceId) : undefined;

        srNo += 1;
        allRows.push({
          id: `${invoice.id}:${srNo}`,
          srNo,
          bu: BUSINESS_UNIT,
          region: store?.regionName ?? '—',
          cluster: store?.clusterName ?? '—',
          storeName: store?.name ?? '—',
          customerGstin: isBusiness ? customer?.gstNumber ?? '' : '',
          customerName: customerName || '—',
          ticketNo: `${store?.code ?? '—'}/${order.orderNumber ?? '—'}`,
          ticketDate: invoice.createdAt ?? null,
          ticketValue: roundRupees(taxableValue + totalTax),
          description: [itemName, serviceName].filter(Boolean).join(' /') || '—',
          sacHsn: SALES_GST_SAC_CODE,
          taxableValue,
          totalTax,
          cgstRate: cgstRatePct,
          cgstAmount,
          sgstRate: sgstRatePct,
          sgstAmount,
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
      }
    }

    const totals = {
      taxableValue: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {taxableValue: number}).taxableValue || 0), 0),
      ),
      totalTax: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {totalTax: number}).totalTax || 0), 0),
      ),
      ticketValue: roundRupees(
        allRows.reduce((sum, row) => sum + ((row as {ticketValue: number}).ticketValue || 0), 0),
      ),
    };

    return {
      rows: allRows.slice(skip, skip + limit),
      totalCount: allRows.length,
      totals,
    };
  }

  /**
   * Consolidated Daily Sales — one row per closed shift per store per
   * day, with the operator-entered closing collections.
   *
   * Only CLOSED shifts appear: an open shift has no closing form yet, so
   * it has no reconciled collections to report.
   */
  /**
   * Consolidated Daily Sales — one row per (store, closure day), matching
   * the Pulse spec's own example (multiple closure numbers/remarks joined
   * into one row when a store had more than one shift that day).
   *
   * Revenue/discount/taxes/totalSales/tickets/items/services and the sales-
   * return figures come straight off Shift.closing (already computed by
   * ShiftController.close() at closure time via resolveRevenue()/
   * resolveSalesReturn() — not recomputed here, so this can't drift from
   * what the cashier actually saw on their closing screen).
   *
   * PSB vs P2D revenue is the one figure closing time never split out —
   * resolveRevenue() sums every order into a single `pressto` bucket
   * regardless of channel. Recomputed here keyed and prorated exactly like
   * resolveRevenue() itself (by invoice generation date, never order
   * createdAt or payment date — see resolveRevenue()'s own doc comment,
   * confirmed directly with the finance team), split by orderType, so
   * PSB + PMU(always 0 — see OTHER_PAYMENT_MODES's neighboring comment,
   * nothing in the schema records a PMU channel) + P2D reconciles exactly
   * against the shift's own stored `revenue` total.
   *
   * "Other Payment Mode" is the other figure the stored snapshot can't
   * answer — Shift.closing.collections only ever buckets cash/card/UPI/
   * cheque/pgLink/wallet/ppVoucher, so a net banking, bank transfer, PDC
   * or pay-later payment is invisible to it. Summed here from the actual
   * PaymentTransaction rows for each shift's orders instead.
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

    const orderIds = orders.map(o => o.id);
    const payments = orderIds.length
      ? await this.paymentTransactionRepo.find({
          where: {
            orderId: {inq: orderIds},
            paymentDate: {between: [earliestOpen, latestClose]},
          } as object,
          fields: {
            orderId: true,
            paymentMode: true,
            amount: true,
            transactionType: true,
            paymentDate: true,
          } as object,
        })
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    // PSB/P2D must be keyed and prorated exactly like ShiftController's own
    // resolveRevenue() (invoice generation date, not order createdAt or
    // payment date; a consolidated invoice's figures split by each linked
    // order's orderTotal ÷ the invoice's totalAmount) or these two stop
    // reconciling against the shift's stored revenue total — see this
    // method's doc comment. A separate fetch from `orders`/`payments` above
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
      ? await this.invoiceOrderLinkRepo.find({
          where: {invoiceId: {inq: revenueInvoices.map(invoice => invoice.id)}} as object,
          fields: {invoiceId: true, orderId: true, orderTotal: true} as object,
        })
      : [];
    const revenueOrderIds = [...new Set(revenueLinks.map(link => link.orderId))];
    const revenueOrders = revenueOrderIds.length
      ? await this.orderRepo.find({
          where: {
            id: {inq: revenueOrderIds},
            storeId: {inq: storeIds},
            status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED]},
          } as object,
          fields: {id: true, storeId: true, orderType: true} as object,
        })
      : [];
    const revenueOrderById = new Map(revenueOrders.map(o => [o.id, o]));

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

      let psbRevenue = 0;
      let p2dRevenue = 0;
      for (const link of revenueLinks) {
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

        const orderTotal = Number(link.orderTotal) || 0;
        let value: number;
        if (invoice.isConsolidated) {
          const invoiceTotal = Number(invoice.totalAmount) || 0;
          const fraction = invoiceTotal > 0 ? Math.min(1, orderTotal / invoiceTotal) : 0;
          value = (Number(invoice.subtotal) || 0) * fraction;
        } else {
          value = Number(invoice.subtotal) || 0;
        }
        if (P2D_ORDER_TYPES.includes(order.orderType as OrderType)) p2dRevenue += value;
        else if (PSB_ORDER_TYPES.includes(order.orderType as OrderType)) psbRevenue += value;
      }

      let otherPaymentMode = 0;
      for (const payment of payments) {
        if (payment.transactionType === 'refund') continue;
        const order = orderById.get(payment.orderId);
        if (!order || order.storeId !== shift.storeId) continue;
        const paidAt = payment.paymentDate ? new Date(payment.paymentDate).getTime() : null;
        if (paidAt == null || paidAt < windowStart || paidAt > windowEnd) continue;
        if (OTHER_PAYMENT_MODES.has(String(payment.paymentMode))) {
          otherPaymentMode += Number(payment.amount) || 0;
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
          discount: 0,
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
      row.p2dRevenue += p2dRevenue;
      row.revenue += Number(revenueCell.revenue) || 0;
      row.discount += Number(revenueCell.discount) || 0;
      row.taxes += Number(revenueCell.taxes) || 0;
      row.totalSales += Number(revenueCell.totalSales) || 0;
      row.noOfTickets += Number(revenueCell.tickets) || 0;
      row.noOfItems += Number(revenueCell.items) || 0;
      row.noOfServices += Number(revenueCell.services) || 0;
      row.otherPaymentMode += otherPaymentMode;
      row.ppVouchers += Number(collections.ppVoucher) || 0;
      row.cash += Number(collections.cash) || 0;
      row.cardsUpi += (Number(collections.card) || 0) + (Number(collections.upi) || 0);
      row.chequesReceived += Number(collections.cheque) || 0;
      row.reimbursed += Number(closing.register?.reimbursement) || 0;
      row.pgLink += Number(collections.pgLink) || 0;
      row.wallet += Number(collections.wallet) || 0;
      row.walletRechargedCash += Number(walletCollections.cash) || 0;
      row.walletRechargedOther +=
        (Number(walletCollections.card) || 0) +
        (Number(walletCollections.upi) || 0) +
        (Number(walletCollections.netBanking) || 0);
      row.totalReceipts =
        row.otherPaymentMode +
        row.ppVouchers +
        row.cash +
        row.cardsUpi +
        row.chequesReceived +
        row.pgLink +
        row.wallet;
      row.supposedBankDeposit += Number(closing.banking?.supposed) || 0;
      row.actualBankDeposit += Number(closing.banking?.deposited) || 0;
      row.diffInDeposit = row.supposedBankDeposit - row.actualBankDeposit;
      row.noOfSalesReturnServices += Number(returnCell.services) || 0;
      row.salesReturnSaleAmount += Number(returnCell.totalSales) || 0;

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
        discount: sum(r => r.discount),
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

  /**
   * Petty Cash Expense — one row per shift closure, per the Pulse
   * requirements sheet ("Data is being pulled from closure report"). Pulls
   * the actual expense claims (date, description, amount, who submitted,
   * approval status) — same as the original version of this report — but
   * each row is also joined to its shift's reconciliation snapshot
   * (opening/closing.pettyCash, same fields Daily Sales reads for
   * banking/revenue), so the Opening/Received/Closing Amount and Shift
   * Open/Closure Diff columns from the Pulse sheet are visible alongside
   * the expense that was actually claimed — a plain listing of claims
   * alone left no way to see the shift-level reconciliation context, and
   * a shift-only summary (tried first) left no way to see what was
   * actually spent. A claim's shift is resolved by matching its
   * expenseDate into a closed shift's [openedAt, closedAt] window at the
   * same store — shifts at a store never overlap, so this is exact, not
   * an approximation. A claim outside any closed shift's window (e.g.
   * submitted against a still-open shift) simply carries no shift
   * context.
   *
   * The spec also asks for a 6-way expense category breakdown (Petrol,
   * Petrol P2D, Petty cash expenses (Stores), DGT, Darner, Vehicle) that
   * this deliberately leaves out: the live expense-entry dropdown
   * (PETTY_EXPENSE_DESCRIPTIONS) uses a different, unrelated category set
   * today, and there is no confirmed mapping between the two yet.
   */
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

    const [{count}, pageEntries, allEntries, shifts] = await Promise.all([
      this.pettyCashRegisterRepo.count(where),
      this.pettyCashRegisterRepo.find({where, order: ['expenseDate DESC'], limit, skip}),
      this.pettyCashRegisterRepo.find({
        where,
        fields: {amount: true, approvedAmount: true} as object,
      }),
      // Closed shifts to resolve each page entry's shift context, matched
      // by the entry's createdAt (see findShiftFor below) rather than its
      // user-editable expenseDate — widened a day past the filter window
      // on each side since createdAt can drift outside [from, to] near a
      // month boundary even though expenseDate stays inside it.
      this.shiftRepo.find({
        where: {
          storeId: {inq: storeIds},
          status: ShiftStatus.CLOSED,
          closedAt: {between: [addDays(from, -1), addDays(to, 1)]},
        } as object,
      }),
    ]);
    if (!count) return emptyPaged();

    type PettyCashClosingCell = {
      prevSupposed?: number;
      recvFromFinance?: number;
      used?: number;
      disapprovedAmt?: number;
      actualBalance?: number;
      difference?: number;
    };
    type PettyCashOpeningCell = {actual?: number; supposed?: number};

    // Matched by createdAt, not expenseDate: PettyCashService.
    // computeWindowActivity (which produces closing.pettyCash.used/
    // recvFromFinance in the first place) scopes entries by createdAt —
    // expenseDate is user-editable/backdatable and can fall well outside
    // the shift that actually accounted for the entry.
    const findShiftFor = (storeId: string, createdAt: Date | undefined) => {
      if (!createdAt) return undefined;
      const t = new Date(createdAt).getTime();
      return shifts.find(
        s =>
          s.storeId === storeId &&
          s.openedAt &&
          s.closedAt &&
          t >= s.openedAt.getTime() &&
          t <= s.closedAt.getTime(),
      );
    };

    return {
      rows: pageEntries.map(entry => {
        const shift = findShiftFor(entry.storeId, entry.createdAt);
        const pettyClosing =
          ((shift?.closing ?? {}) as {pettyCash?: PettyCashClosingCell}).pettyCash ?? {};
        const pettyOpening =
          ((shift?.opening ?? {}) as {pettyCash?: PettyCashOpeningCell}).pettyCash ?? {};

        return {
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
          closureNo: shift
            ? shift.closureNo != null
              ? String(shift.closureNo)
              : String(shift.openingNo)
            : '—',
          openingAmount: Number(pettyClosing.prevSupposed) || 0,
          receivedAmount: Number(pettyClosing.recvFromFinance) || 0,
          closingAmount: Number(pettyClosing.actualBalance) || 0,
          shiftOpenDiff: (Number(pettyOpening.actual) || 0) - (Number(pettyOpening.supposed) || 0),
          shiftClosureDiff: Number(pettyClosing.difference) || 0,
          shiftDisapprovedAmt: Number(pettyClosing.disapprovedAmt) || 0,
          shiftTotalExpense: Number(pettyClosing.used) || 0,
        };
      }),
      totalCount: count,
      totals: {
        claimed: allEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0),
        approved: allEntries.reduce((s, e) => s + (Number(e.approvedAmount) || 0), 0),
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
            code: s.code ?? '—',
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
