import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';
import {ShiftStatus} from '../models/shift-status.enum';
import {TransferStatus} from '../models/transfer-status.enum';
import {
  DeliveryOrderRepository,
  DeliveryRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  RiderCashHandoverRepository,
  ShiftRepository,
  TransferItemRepository,
  TransferRepository,
} from '../repositories';
import {PettyCashService} from './petty-cash.service';

/** Money taken at the counter, bucketed the way the dashboard presents it. */
type CollectionBuckets = {
  cash: number;
  card: number;
  cheque: number;
  pgLink: number;
  wallet: number;
};

const emptyCollections = (): CollectionBuckets => ({
  cash: 0,
  card: 0,
  cheque: 0,
  pgLink: 0,
  wallet: 0,
});

/**
 * One payment mode → one dashboard bucket. `null` means the mode takes no
 * money at the counter in this window: PAY_LATER is billed after delivery
 * and ON_ACCOUNT draws down a B2B deposit.
 *
 * NOTE: ShiftController.collected() keeps its own copy of this mapping for
 * the shift-closing form. The two are deliberately independent so this
 * screen cannot affect that one — but they answer the same question, so a
 * new payment mode has to be added in BOTH places or the dashboard KPI and
 * the closing form will disagree about the same store takings.
 */
const BUCKET_OF: Record<string, keyof CollectionBuckets | null> = {
  [PaymentMode.CASH]: 'cash',
  [PaymentMode.CARD]: 'card',
  [PaymentMode.CHEQUE]: 'cheque',
  [PaymentMode.PDC]: 'cheque',
  [PaymentMode.UPI]: 'pgLink',
  [PaymentMode.NET_BANKING]: 'pgLink',
  [PaymentMode.BANK_TRANSFER]: 'pgLink',
  [PaymentMode.GATEWAY]: 'pgLink',
  [PaymentMode.WALLET]: 'wallet',
  [PaymentMode.PAY_LATER]: null,
  [PaymentMode.ON_ACCOUNT]: null,
};

/**
 * True when the requested window is today's calendar day — the live
 * dashboard view, as opposed to a historical range the user picked.
 * Only that view aligns its cash figure to the open shift.
 */
function isTodayWindow(from: Date, to: Date): boolean {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return (
    from.getTime() === startOfToday.getTime() && to.getTime() === endOfToday.getTime()
  );
}

/** Statuses that still count as moving through the plant. */
const IN_PROCESS_STATUSES = [GarmentStatus.IN_PROCESS, GarmentStatus.QUALITY_CHECK];

/** A transfer that has left its origin but has not been booked in yet. */
const IN_FLIGHT_TRANSFER_STATUSES = [
  TransferStatus.SENT,
  TransferStatus.RIDER_ASSIGNED,
  TransferStatus.IN_TRANSIT,
];

/**
 * How an order payment mode is labelled on the "Orders & items today"
 * card. Anything not listed rolls up under the trailing "Unpaid / other"
 * row so the rows always re-add to the orders-today KPI.
 */
const ORDER_PAYMENT_LABELS: {key: string; label: string; modes: PaymentMode[]}[] = [
  {key: 'prepaidCash', label: 'Prepaid cash', modes: [PaymentMode.CASH]},
  {
    key: 'cardPg',
    label: 'Card / PG',
    modes: [
      PaymentMode.CARD,
      PaymentMode.UPI,
      PaymentMode.NET_BANKING,
      PaymentMode.BANK_TRANSFER,
      PaymentMode.GATEWAY,
    ],
  },
  {key: 'wallet', label: 'Wallet', modes: [PaymentMode.WALLET]},
  {key: 'payLater', label: 'Pay later', modes: [PaymentMode.PAY_LATER, PaymentMode.ON_ACCOUNT]},
];

export type StoreDashboardSummary = {
  storeIds: string[];
  window: {from: string; to: string};
  cashBasis: 'shift' | 'day';
  kpis: object;
  pipeline: object;
  ordersToday: object[];
  pettyRider: object;
  dispatched: object[];
  transfers: object;
};

/**
 * Everything the store dashboard shows, assembled in one pass.
 *
 * Every panel is scoped to `storeIds`, which the controller has already
 * intersected against the caller own store scope — this service never
 * widens what it is handed, and an empty list yields an empty summary
 * rather than an unscoped one.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class DashboardService {
  constructor(
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(TransferRepository) private transferRepo: TransferRepository,
    @repository(TransferItemRepository) private transferItemRepo: TransferItemRepository,
    @repository(DeliveryRepository) private deliveryRepo: DeliveryRepository,
    @repository(DeliveryOrderRepository) private deliveryOrderRepo: DeliveryOrderRepository,
    @repository(PaymentTransactionRepository)
    private paymentTransactionRepo: PaymentTransactionRepository,
    @repository(RiderCashHandoverRepository)
    private riderCashHandoverRepo: RiderCashHandoverRepository,
    @repository(ShiftRepository) private shiftRepo: ShiftRepository,
    @inject('services.petty-cash') private pettyCashService: PettyCashService,
  ) {}

  async buildStoreSummary(
    storeIds: string[],
    from: Date,
    to: Date,
  ): Promise<StoreDashboardSummary> {
    const window = {from: from.toISOString(), to: to.toISOString()};

    if (!storeIds.length) return this.emptySummary(window);

    // Cash is reported over the open shift window ONLY on the live
    // "today" view, where the KPI sits beside the shift banner and the
    // Shift Closure button and so must quote the same figure the closing
    // form will.
    //
    // It must NOT do that for a historical range: a shift opened partway
    // through the range would silently start the cash total late while
    // every other KPI on the same card covered the full range, so one row
    // would be reporting two different windows. Any explicit past range
    // therefore uses exactly the window asked for.
    const activeShift = isTodayWindow(from, to) ? await this.findActiveShift(storeIds) : null;
    const cashFrom = activeShift?.openedAt ?? from;

    const [cashBreakdown, orderStats, pipeline, dispatched, transfers, pettyRider] =
      await Promise.all([
        this.computeOrderCollections(storeIds, cashFrom, to),
        this.computeOrderStats(storeIds, from, to),
        this.computePipeline(storeIds),
        this.computeDispatched(storeIds, from, to),
        this.computeTransfers(storeIds, from, to),
        this.computePettyRider(storeIds, from, to),
      ]);

    const cashCollected = Object.values(cashBreakdown).reduce((sum, v) => sum + v, 0);

    return {
      storeIds,
      window,
      cashBasis: activeShift ? 'shift' : 'day',
      kpis: {
        cashCollected,
        cashBreakdown,
        ordersToday: orderStats.orderCount,
        itemsToday: orderStats.itemCount,
        dispatchedToday: dispatched.length,
        transfersToday: {
          sent: transfers.sent,
          received: transfers.received,
          items: transfers.items,
          discrepancy: transfers.discrepancy,
        },
      },
      pipeline,
      ordersToday: orderStats.rows,
      pettyRider,
      dispatched,
      transfers,
    };
  }

  /** Zeroed payload — a caller scoped to no store sees nothing, not everything. */
  private emptySummary(window: {from: string; to: string}): StoreDashboardSummary {
    return {
      storeIds: [],
      window,
      cashBasis: 'day',
      kpis: {
        cashCollected: 0,
        cashBreakdown: emptyCollections(),
        ordersToday: 0,
        itemsToday: 0,
        dispatchedToday: 0,
        transfersToday: {sent: 0, received: 0, items: 0, discrepancy: 0},
      },
      pipeline: {ready: 0, inProcess: 0, pendingReceive: 0},
      ordersToday: [],
      pettyRider: {
        pettyUsedToday: 0,
        pettyBalance: 0,
        riderChangePending: 0,
        riderChangeConfirmedToday: 0,
      },
      dispatched: [],
      transfers: {sent: 0, received: 0, items: 0, discrepancy: 0, rows: []},
    };
  }

  /**
   * Order-payment collections for these stores between `from` and `to`.
   *
   * Note the two different scopes: EVERY order belonging to the store is a
   * candidate (an order placed last week can be paid for today), but only
   * transactions whose paymentDate falls inside the window are counted.
   * Refunds are excluded, and so are rider-collected payments (riderId
   * set) — those settle through the rider cash-handover flow and were
   * never in the store till.
   */
  private async computeOrderCollections(
    storeIds: string[],
    from: Date,
    to: Date,
  ): Promise<CollectionBuckets> {
    const collections = emptyCollections();
    if (!storeIds.length) return collections;

    const orders = await this.orderRepo.find({
      where: {storeId: {inq: storeIds}} as object,
      fields: {id: true} as object,
    });
    const orderIds = orders.map(o => o.id);
    if (!orderIds.length) return collections;

    const transactions = await this.paymentTransactionRepo.find({
      where: {
        orderId: {inq: orderIds},
        riderId: null,
        transactionType: {neq: 'refund'},
        paymentDate: {between: [from, to]},
      } as object,
      fields: {paymentMode: true, amount: true} as object,
    });

    for (const t of transactions) {
      const bucket = BUCKET_OF[t.paymentMode];
      if (bucket) collections[bucket] += Number(t.amount) || 0;
    }
    return collections;
  }

  /** The open shift for these stores, if any. */
  private async findActiveShift(storeIds: string[]) {
    return this.shiftRepo.findOne({
      where: {storeId: {inq: storeIds}, status: ShiftStatus.OPEN} as object,
      order: ['openedAt DESC'],
    });
  }

  /**
   * Orders raised in the window, their garment count, and a breakdown by
   * how they were paid. Cancelled orders are excluded — they are not
   * business done today.
   */
  private async computeOrderStats(storeIds: string[], from: Date, to: Date) {
    const orders = await this.orderRepo.find({
      where: {
        storeId: {inq: storeIds},
        status: {neq: OrderStatus.CANCELLED},
        createdAt: {between: [from, to]},
      } as object,
      fields: {id: true, totalAmount: true} as object,
    });
    const orderIds = orders.map(o => o.id);
    if (!orderIds.length) return {orderCount: 0, itemCount: 0, rows: []};

    const [orderItems, transactions] = await Promise.all([
      this.orderItemRepo.find({
        where: {orderId: {inq: orderIds}} as object,
        fields: {id: true} as object,
      }),
      this.paymentTransactionRepo.find({
        where: {orderId: {inq: orderIds}, transactionType: {neq: 'refund'}} as object,
        fields: {orderId: true, paymentMode: true, amount: true} as object,
      }),
    ]);

    const itemCount = orderItems.length
      ? (
          await this.garmentRepo.count({
            orderItemId: {inq: orderItems.map(oi => oi.id)},
            isDeleted: false,
          } as object)
        ).count
      : 0;

    // An order is labelled by the first payment mode recorded against it,
    // so a split-tender order lands in the bucket it opened with rather
    // than being counted once under each mode it used.
    const modeByOrder = new Map<string, PaymentMode>();
    const amountByOrder = new Map<string, number>();
    for (const t of transactions) {
      if (!modeByOrder.has(t.orderId)) modeByOrder.set(t.orderId, t.paymentMode);
      amountByOrder.set(t.orderId, (amountByOrder.get(t.orderId) ?? 0) + (Number(t.amount) || 0));
    }

    // `?? 0` would not catch this: Number(undefined) is NaN, and NaN is
    // neither null nor undefined, so an unpaid order with no totalAmount
    // would poison the whole row sum and render as "₹NaN".
    const amountOf = (orderId: string, fallback?: number) =>
      amountByOrder.get(orderId) ?? (Number(fallback) || 0);

    const labelledModes = new Set(ORDER_PAYMENT_LABELS.flatMap(l => l.modes));

    const rows = ORDER_PAYMENT_LABELS.map(({key, label, modes}) => {
      const matching = orders.filter(o => {
        const mode = modeByOrder.get(o.id);
        return mode !== undefined && modes.includes(mode);
      });
      return {
        key,
        label,
        count: matching.length,
        amount: matching.reduce((sum, o) => sum + amountOf(o.id, o.totalAmount), 0),
      };
    }).filter(row => row.count > 0);

    // Orders with no payment yet, or paid by a mode not named above.
    const unlabelled = orders.filter(o => {
      const mode = modeByOrder.get(o.id);
      return mode === undefined || !labelledModes.has(mode);
    });
    if (unlabelled.length) {
      rows.push({
        key: 'other',
        label: 'Unpaid / other',
        count: unlabelled.length,
        amount: unlabelled.reduce((sum, o) => sum + amountOf(o.id, o.totalAmount), 0),
      });
    }

    return {orderCount: orders.length, itemCount, rows};
  }

  /**
   * Live garment counts for the store — a stock position, not a window,
   * so it is deliberately not date-filtered.
   *
   * Garments carry no storeId of their own; they reach a store through
   * orderItem then order. `pendingReceive` is the exception: those
   * garments belong to another store order and are counted off the
   * inbound transfer instead.
   */
  private async computePipeline(storeIds: string[]) {
    const orders = await this.orderRepo.find({
      where: {storeId: {inq: storeIds}} as object,
      fields: {id: true} as object,
    });
    const orderIds = orders.map(o => o.id);

    let ready = 0;
    let inProcess = 0;
    if (orderIds.length) {
      const orderItems = await this.orderItemRepo.find({
        where: {orderId: {inq: orderIds}} as object,
        fields: {id: true} as object,
      });
      const orderItemIds = orderItems.map(oi => oi.id);
      if (orderItemIds.length) {
        const [readyCount, inProcessCount] = await Promise.all([
          this.garmentRepo.count({
            orderItemId: {inq: orderItemIds},
            status: GarmentStatus.READY,
            isDeleted: false,
          } as object),
          this.garmentRepo.count({
            orderItemId: {inq: orderItemIds},
            status: {inq: IN_PROCESS_STATUSES},
            isDeleted: false,
          } as object),
        ]);
        ready = readyCount.count;
        inProcess = inProcessCount.count;
      }
    }

    const inbound = await this.transferRepo.find({
      where: {
        toStoreId: {inq: storeIds},
        status: {inq: IN_FLIGHT_TRANSFER_STATUSES},
        isDeleted: false,
      } as object,
      fields: {id: true} as object,
    });
    const pendingReceive = inbound.length
      ? (await this.transferItemRepo.count({transferId: {inq: inbound.map(t => t.id)}} as object))
          .count
      : 0;

    return {ready, inProcess, pendingReceive};
  }

  /** Deliveries that physically left the store inside the window. */
  private async computeDispatched(storeIds: string[], from: Date, to: Date) {
    const deliveries = await this.deliveryRepo.find({
      where: {
        storeId: {inq: storeIds},
        startedAt: {between: [from, to]},
        isDeleted: false,
      } as object,
      order: ['startedAt DESC'],
    });
    if (!deliveries.length) return [];

    const deliveryById = new Map(deliveries.map(d => [d.id, d]));
    const deliveryOrders = await this.deliveryOrderRepo.find({
      where: {deliveryId: {inq: deliveries.map(d => d.id)}} as object,
    });

    return deliveryOrders.map(row => {
      const delivery = deliveryById.get(row.deliveryId);
      return {
        orderId: row.orderId,
        orderNo: row.orderNumber,
        customer: row.customerName,
        rider: delivery?.riderName ?? '',
        dispatchedAt: delivery?.startedAt ?? null,
        status: row.status,
      };
    });
  }

  /**
   * Inter-store movement. Counts are window-scoped (what moved today);
   * `rows` shows those same transfers for the table beneath them.
   */
  private async computeTransfers(storeIds: string[], from: Date, to: Date) {
    const transfers = await this.transferRepo.find({
      where: {
        and: [
          {or: [{fromStoreId: {inq: storeIds}}, {toStoreId: {inq: storeIds}}]},
          {or: [{sentAt: {between: [from, to]}}, {receivedAt: {between: [from, to]}}]},
          {isDeleted: false},
        ],
      } as object,
      order: ['sentAt DESC'],
    });

    const inWindow = (d?: Date | null) => Boolean(d && new Date(d) >= from && new Date(d) <= to);
    const sent = transfers.filter(t => storeIds.includes(t.fromStoreId) && inWindow(t.sentAt));
    const received = transfers.filter(t => storeIds.includes(t.toStoreId) && inWindow(t.receivedAt));

    return {
      sent: sent.length,
      received: received.length,
      items: transfers.reduce((sum, t) => sum + (Number(t.itemCount) || 0), 0),
      discrepancy: transfers.filter(t => t.status === TransferStatus.DISCREPANCY).length,
      rows: transfers.slice(0, 10).map(t => ({
        id: t.id,
        transitId: t.transitId,
        direction: storeIds.includes(t.fromStoreId) ? 'Outgoing' : 'Incoming',
        items: Number(t.itemCount) || 0,
        status: t.status,
        at: t.receivedAt ?? t.sentAt ?? null,
      })),
    };
  }

  /**
   * Petty cash float plus the cash riders are still carrying for this
   * store. Rider cash is read off the payment transactions themselves
   * (riderHandoverStatus) rather than the handover batches, because money
   * a rider has collected but not yet submitted has no batch row yet.
   */
  private async computePettyRider(storeIds: string[], from: Date, to: Date) {
    const [windowActivity, balances, orders] = await Promise.all([
      // Both petty-cash helpers are per-store; sum across the caller stores.
      Promise.all(storeIds.map(id => this.pettyCashService.computeWindowActivity(id, from, to))),
      Promise.all(storeIds.map(id => this.pettyCashService.computeBalance(id))),
      this.orderRepo.find({
        where: {storeId: {inq: storeIds}} as object,
        fields: {id: true} as object,
      }),
    ]);

    const pettyUsedToday = windowActivity.reduce((sum, a) => sum + (Number(a.used) || 0), 0);
    const pettyBalance = balances.reduce((sum, b) => sum + (Number(b) || 0), 0);

    let riderChangePending = 0;
    const orderIds = orders.map(o => o.id);
    if (orderIds.length) {
      const withRider = await this.paymentTransactionRepo.find({
        where: {
          orderId: {inq: orderIds},
          riderId: {neq: null},
          riderHandoverStatus: {inq: ['with_rider', 'submitted']},
        } as object,
        fields: {amount: true} as object,
      });
      riderChangePending = withRider.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    }

    const confirmed = await this.riderCashHandoverRepo.find({
      where: {
        handoverToStoreId: {inq: storeIds},
        status: RiderCashHandoverStatus.CONFIRMED,
        confirmedAt: {between: [from, to]},
        isDeleted: false,
      } as object,
      fields: {totalAmount: true} as object,
    });

    return {
      pettyUsedToday,
      pettyBalance,
      riderChangePending,
      riderChangeConfirmedToday: confirmed.reduce(
        (sum, h) => sum + (Number(h.totalAmount) || 0),
        0,
      ),
    };
  }
}
