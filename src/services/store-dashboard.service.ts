import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PresstoDataSource} from '../datasources';
import {OrderStatus} from '../models/order-status.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';
import {ShiftStatus} from '../models/shift-status.enum';
import {ShiftRepository} from '../repositories';
import {BUCKET_OF, isTodayWindow} from './dashboard.service';

/** Lists that ignore the date range — a live position of the store. */
export const LIVE_LISTS = [
  'overdue',
  'ready',
  'inStore',
  'pickups',
  'riders',
] as const;
/** Lists scoped to the dashboard's selected date range. */
export const WINDOW_LISTS = ['pending', 'deliveries'] as const;

export type LiveList = (typeof LIVE_LISTS)[number];
export type WindowList = (typeof WINDOW_LISTS)[number];
export type DashboardList = LiveList | WindowList;

export const DASHBOARD_LISTS: readonly string[] = [
  ...LIVE_LISTS,
  ...WINDOW_LISTS,
];

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

/**
 * "Not yet delivered" — the ticket is still owed to the customer. Draft is
 * excluded because it was never placed; cancelled and returned are closed.
 */
const CLOSED_ORDER_STATUSES: string[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
  OrderStatus.DRAFT,
];
const OPEN_ORDER_STATUSES: string[] = Object.values(OrderStatus).filter(
  status => !CLOSED_ORDER_STATUSES.includes(status),
);

const READY_ORDER_STATUSES: string[] = [OrderStatus.READY];

/** Physically at the store, ready tickets included. */
const IN_STORE_ORDER_STATUSES: string[] = [
  OrderStatus.RECEIVED_AT_STORE,
  OrderStatus.IN_INSPECTION,
  OrderStatus.IN_PROCESS,
  OrderStatus.QUALITY_CHECK,
  OrderStatus.ON_HOLD,
  OrderStatus.READY,
];

/** A pickup the store still has to go and collect. */
const OPEN_PICKUP_STATUSES: string[] = [
  PickupRequestStatus.REQUESTED,
  PickupRequestStatus.SCHEDULED,
  PickupRequestStatus.RIDER_ASSIGNED,
  PickupRequestStatus.OUT_FOR_PICKUP,
  PickupRequestStatus.ARRIVED_AT_PICKUP,
];

/** A pickup that is currently occupying its rider. */
const ACTIVE_RIDER_PICKUP_STATUSES: string[] = [
  PickupRequestStatus.RIDER_ASSIGNED,
  PickupRequestStatus.OUT_FOR_PICKUP,
  PickupRequestStatus.ARRIVED_AT_PICKUP,
  PickupRequestStatus.PICKED_UP,
];

/** Rider-collected cash not yet accepted by the store. */
const PENDING_HANDOVER_STATUSES = ['with_rider', 'submitted'];

/**
 * Payment modes that put money in the store till. Derived from the same
 * mapping DashboardService uses so the "Collected" KPI cannot drift from
 * the figure the shift-closing form reconciles against.
 */
const COLLECTED_PAYMENT_MODES = Object.entries(BUCKET_OF)
  .filter(([, bucket]) => bucket !== null)
  .map(([mode]) => mode);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A timestamptz rendered by Postgres as text, or the 'infinity' sentinel. */
const PG_TIMESTAMP =
  /^(infinity|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?)$/;
const INTEGER = /^\d{1,9}$/;

export type Page<T> = {rows: T[]; nextCursor: string | null};

export type TicketRow = {
  id: string;
  orderNo: string;
  status: string;
  customerName: string;
  itemCount: number;
  deliveryDate: Date | null;
};

export type PickupRow = {
  id: string;
  pickupNumber: string;
  customerName: string;
  requestedDate: Date | null;
  slot: string;
  status: string;
  missed: boolean;
};

export type DeliveryRow = {
  id: string;
  orderId: string;
  orderNo: string;
  customerName: string;
  riderName: string;
  dispatchedAt: Date | null;
};

export type RiderRow = {
  riderId: string;
  riderName: string;
  pickups: number;
  deliveries: number;
};

export type DashboardWindow = {from: Date; to: Date};

type Cursor = {k: string; id: string};
type Row = Record<string, unknown>;

/** Collects positional parameters so each fragment can name its own. */
class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function encodeCursor(k: string, id: string): string {
  return Buffer.from(JSON.stringify([k, id]), 'utf8').toString('base64url');
}

/**
 * Cursors are opaque to the client but come back as user input, so they
 * are shape-checked here before any value reaches a SQL cast — a bad
 * cast would otherwise surface as a 500 instead of a 400.
 */
export function decodeCursor(
  raw: string | undefined,
  keyShape: RegExp,
  idShape: RegExp,
): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      keyShape.test(parsed[0]) &&
      idShape.test(parsed[1])
    ) {
      return {k: parsed[0], id: parsed[1]};
    }
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpErrors.BadRequest('cursor is invalid.');
}

/** Trim the look-ahead row and derive the cursor from the last kept one. */
function toPage<T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  key: (row: Row) => [string, string],
): Page<T> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    rows: kept.map(map),
    nextCursor: hasMore && last ? encodeCursor(...key(last)) : null,
  };
}

const EMPTY_PAGE: Page<never> = {rows: [], nextCursor: null};

/**
 * Which tickets a store's dashboard covers: its own, plus other stores'
 * tickets whose garments are on an inter-store transfer to it — the same
 * additive visibility StoreScopeService.transferGrantedOrderIds gives the
 * orders list. Written against alias `o` (orders).
 *
 * The granted ids are an ARRAY(subquery), evaluated once per statement,
 * so both arms stay index lookups (storeid composite index / primary key)
 * rather than a per-row subplan over the whole orders table.
 */
function ticketScopeSql(q: SqlParams, storeIds: string[]): string {
  const stores = q.add(storeIds);
  return `(o.storeid = ANY(${stores}::uuid[]) OR o.id = ANY(ARRAY(
      SELECT oi.orderid
      FROM transfer t
      JOIN garment g ON g.activetransferid = t.id AND g.isdeleted = false
      JOIN order_item oi ON oi.id = g.orderitemid
      WHERE t.tostoreid = ANY(${stores}::uuid[])
    )))`;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const num = (value: unknown) => Number(value) || 0;
const str = (value: unknown) =>
  value === null || value === undefined ? '' : String(value);

/**
 * Store dashboard, built for a paged UI: aggregate figures come from
 * COUNT/SUM queries (so badges show true totals), and every list returns
 * one keyset page — first `limit` rows plus a cursor for "Show more".
 *
 * `storeIds` has already been intersected with the caller's own scope by
 * the controller; this service never widens it, and an empty list yields
 * an empty payload rather than an unscoped one.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class StoreDashboardService {
  constructor(
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
    @repository(ShiftRepository) private shiftRepo: ShiftRepository,
  ) {}

  // ─── Payloads ─────────────────────────────────────────────────────────────

  /** Everything that ignores the date range: counts plus first pages. */
  async live(storeIds: string[], limit: number) {
    if (!storeIds.length) {
      return {
        counts: {
          overdue: 0,
          ready: 0,
          inStore: 0,
          pickups: 0,
          missedPickups: 0,
          riders: 0,
        },
        handover: {pending: 0},
        lists: {
          overdue: EMPTY_PAGE,
          ready: EMPTY_PAGE,
          inStore: EMPTY_PAGE,
          pickups: EMPTY_PAGE,
          riders: EMPTY_PAGE,
        },
      };
    }

    const today = startOfToday();
    const [aggregates, overdue, ready, inStore, pickups, riders] =
      await Promise.all([
        this.liveAggregates(storeIds, today),
        this.overduePage(storeIds, today, null, limit),
        this.statusPage(storeIds, READY_ORDER_STATUSES, null, limit),
        this.statusPage(storeIds, IN_STORE_ORDER_STATUSES, null, limit),
        this.pickupPage(storeIds, today, null, limit),
        this.riderPage(storeIds, null, limit),
      ]);

    return {
      counts: {
        overdue: num(aggregates.overdue),
        ready: num(aggregates.ready),
        inStore: num(aggregates.instore),
        pickups: num(aggregates.pickups),
        missedPickups: num(aggregates.missedpickups),
        riders: num(aggregates.riders),
      },
      handover: {pending: num(aggregates.handoverpending)},
      lists: {overdue, ready, inStore, pickups, riders},
    };
  }

  /** Everything scoped to the selected date range. */
  async window(storeIds: string[], window: DashboardWindow, limit: number) {
    if (!storeIds.length) {
      return {
        cashBasis: 'day' as const,
        kpis: {collected: 0, tickets: 0},
        counts: {pending: 0, deliveries: 0},
        handover: {accepted: 0},
        lists: {pending: EMPTY_PAGE, deliveries: EMPTY_PAGE},
      };
    }

    // Same rule as DashboardService: only the live "today" view aligns
    // cash to the open shift, so it quotes what the closing form will.
    const activeShift = isTodayWindow(window.from, window.to)
      ? await this.shiftRepo.findOne({
          where: {storeId: {inq: storeIds}, status: ShiftStatus.OPEN} as object,
          order: ['openedAt DESC'],
          fields: {openedAt: true} as object,
        })
      : null;
    const cashFrom = activeShift?.openedAt
      ? new Date(activeShift.openedAt)
      : window.from;

    const [aggregates, pending, deliveries] = await Promise.all([
      this.windowAggregates(storeIds, window, cashFrom),
      this.pendingPage(storeIds, window, null, limit),
      this.deliveryPage(storeIds, window, null, limit),
    ]);

    return {
      cashBasis: activeShift ? ('shift' as const) : ('day' as const),
      kpis: {
        collected: num(aggregates.collected),
        tickets: num(aggregates.tickets),
      },
      counts: {
        pending: num(aggregates.pending),
        deliveries: num(aggregates.deliveries),
      },
      handover: {accepted: num(aggregates.accepted)},
      lists: {pending, deliveries},
    };
  }

  /** One further page of a single list — what "Show more" calls. */
  async listPage(
    list: DashboardList,
    storeIds: string[],
    window: DashboardWindow,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<Page<unknown>> {
    const today = startOfToday();
    switch (list) {
      case 'overdue':
        return this.overduePage(
          storeIds,
          today,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'pending':
        return this.pendingPage(
          storeIds,
          window,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'ready':
        return this.statusPage(
          storeIds,
          READY_ORDER_STATUSES,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'inStore':
        return this.statusPage(
          storeIds,
          IN_STORE_ORDER_STATUSES,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'pickups':
        return this.pickupPage(
          storeIds,
          today,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'deliveries':
        return this.deliveryPage(
          storeIds,
          window,
          decodeCursor(rawCursor, PG_TIMESTAMP, UUID),
          limit,
        );
      case 'riders':
        // Rider ids are free text on pickup_request, so only length-checked.
        return this.riderPage(
          storeIds,
          decodeCursor(rawCursor, INTEGER, /^.{1,64}$/),
          limit,
        );
    }
  }

  // ─── Aggregates ───────────────────────────────────────────────────────────

  private async liveAggregates(storeIds: string[], today: Date): Promise<Row> {
    const q = new SqlParams();
    const stores = q.add(storeIds);
    const open = q.add(OPEN_ORDER_STATUSES);
    const todayParam = q.add(today);
    const loads = this.riderLoadsSql(q, storeIds);

    const rows: Row[] = await this.dataSource.execute(
      `WITH tickets AS (
         SELECT
           COUNT(*) FILTER (WHERE o.deliverydate < ${todayParam})::int AS overdue,
           COUNT(*) FILTER (WHERE o.status = ANY(${q.add(READY_ORDER_STATUSES)}::text[]))::int AS ready,
           COUNT(*) FILTER (WHERE o.status = ANY(${q.add(IN_STORE_ORDER_STATUSES)}::text[]))::int AS instore
         FROM orders o
         WHERE ${ticketScopeSql(q, storeIds)}
           AND o.isdeleted IS NOT TRUE
           AND o.status = ANY(${open}::text[])
       ),
       pickups AS (
         SELECT
           COUNT(*)::int AS pickups,
           COUNT(*) FILTER (WHERE pr.requesteddate < ${todayParam})::int AS missedpickups
         FROM pickup_request pr
         WHERE pr.storeid = ANY(${q.add(storeIds)}::text[])
           AND pr.isdeleted IS NOT TRUE
           AND pr.status = ANY(${q.add(OPEN_PICKUP_STATUSES)}::text[])
       ),
       handover AS (
         SELECT COALESCE(SUM(pt.amount), 0) AS handoverpending
         FROM payment_transaction pt
         JOIN orders o ON o.id = pt.orderid
         WHERE o.storeid = ANY(${stores}::uuid[])
           AND pt.riderid IS NOT NULL
           AND pt.riderhandoverstatus = ANY(${q.add(PENDING_HANDOVER_STATUSES)}::text[])
       ),
       riders AS (
         SELECT COUNT(DISTINCT riderid)::int AS riders FROM (${loads}) loads
       )
       SELECT * FROM tickets, pickups, handover, riders`,
      q.values,
    );
    return rows[0] ?? {};
  }

  private async windowAggregates(
    storeIds: string[],
    window: DashboardWindow,
    cashFrom: Date,
  ): Promise<Row> {
    const q = new SqlParams();
    const stores = q.add(storeIds);
    const from = q.add(window.from);
    const to = q.add(window.to);

    // Collected mirrors DashboardService.computeOrderCollections: any of
    // the store's tickets (a ticket raised last week can be paid today),
    // counter payments only (rider cash settles through handover), no
    // refunds, and only modes that put money in the till.
    const rows: Row[] = await this.dataSource.execute(
      `SELECT
         (SELECT COALESCE(SUM(pt.amount), 0)
            FROM payment_transaction pt
            JOIN orders o ON o.id = pt.orderid
           WHERE o.storeid = ANY(${stores}::uuid[])
             AND pt.riderid IS NULL
             AND pt.transactiontype <> 'refund'
             AND pt.paymentmode = ANY(${q.add(COLLECTED_PAYMENT_MODES)}::text[])
             AND pt.paymentdate BETWEEN ${q.add(cashFrom)} AND ${to}) AS collected,
         (SELECT COUNT(*)
            FROM orders o
           WHERE o.storeid = ANY(${stores}::uuid[])
             AND o.status <> ${q.add(OrderStatus.CANCELLED)}
             AND o.createdat BETWEEN ${from} AND ${to})::int AS tickets,
         (SELECT COUNT(*)
            FROM orders o
           WHERE ${ticketScopeSql(q, storeIds)}
             AND o.isdeleted IS NOT TRUE
             AND o.status = ANY(${q.add(OPEN_ORDER_STATUSES)}::text[])
             AND o.deliverydate BETWEEN ${from} AND ${to})::int AS pending,
         (SELECT COUNT(*)
            FROM delivery d
            JOIN delivery_order dor ON dor.deliveryid = d.id
           WHERE d.storeid = ANY(${stores}::uuid[])
             AND d.isdeleted IS NOT TRUE
             AND d.startedat BETWEEN ${from} AND ${to})::int AS deliveries,
         (SELECT COALESCE(SUM(h.totalamount), 0)
            FROM rider_cash_handover h
           WHERE h.handovertostoreid = ANY(${stores}::uuid[])
             AND h.status = ${q.add(RiderCashHandoverStatus.CONFIRMED)}
             AND h.isdeleted IS NOT TRUE
             AND h.confirmedat BETWEEN ${from} AND ${to}) AS accepted`,
      q.values,
    );
    return rows[0] ?? {};
  }

  // ─── Ticket lists ─────────────────────────────────────────────────────────

  /** Delivery date has passed and the ticket is still not delivered. */
  private overduePage(
    storeIds: string[],
    today: Date,
    cursor: Cursor | null,
    limit: number,
  ) {
    return this.ticketPage(
      storeIds,
      q =>
        `o.status = ANY(${q.add(OPEN_ORDER_STATUSES)}::text[]) AND o.deliverydate < ${q.add(today)}`,
      cursor,
      limit,
    );
  }

  /** Due for delivery inside the window and not yet delivered — past windows included. */
  private pendingPage(
    storeIds: string[],
    window: DashboardWindow,
    cursor: Cursor | null,
    limit: number,
  ) {
    return this.ticketPage(
      storeIds,
      q =>
        `o.status = ANY(${q.add(OPEN_ORDER_STATUSES)}::text[])` +
        ` AND o.deliverydate BETWEEN ${q.add(window.from)} AND ${q.add(window.to)}`,
      cursor,
      limit,
    );
  }

  private statusPage(
    storeIds: string[],
    statuses: string[],
    cursor: Cursor | null,
    limit: number,
  ) {
    return this.ticketPage(
      storeIds,
      q => `o.status = ANY(${q.add(statuses)}::text[])`,
      cursor,
      limit,
    );
  }

  /**
   * One keyset page of tickets, nearest delivery date first. Undated
   * tickets sort last ('infinity') so the key is never NULL, which keeps
   * the row comparison in the cursor predicate well defined.
   *
   * The customer join and item-count subquery sit OUTSIDE the LIMIT so
   * they run for the page's rows only, not every matching ticket.
   */
  private async ticketPage(
    storeIds: string[],
    filter: (q: SqlParams) => string,
    cursor: Cursor | null,
    limit: number,
  ): Promise<Page<TicketRow>> {
    if (!storeIds.length) return EMPTY_PAGE;

    const q = new SqlParams();
    const sortKey = `COALESCE(o.deliverydate, 'infinity'::timestamptz)`;
    const conditions = [
      ticketScopeSql(q, storeIds),
      'o.isdeleted IS NOT TRUE',
      filter(q),
    ];
    if (cursor) {
      conditions.push(
        `(${sortKey}, o.id) > (${q.add(cursor.k)}::timestamptz, ${q.add(cursor.id)}::uuid)`,
      );
    }

    const rows: Row[] = await this.dataSource.execute(
      `SELECT
         t.id, t.ordernumber, t.status, t.deliverydate, t.sortkey,
         COALESCE(
           NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''),
           NULLIF(TRIM(c.companyname), ''),
           'Customer'
         ) AS customername,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_item oi WHERE oi.orderid = t.id)::int AS itemcount
       FROM (
         SELECT o.id, o.ordernumber, o.status, o.deliverydate, o.customerid,
                ${sortKey} AS sortts, ${sortKey}::text AS sortkey
         FROM orders o
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${sortKey}, o.id
         LIMIT ${q.add(limit + 1)}
       ) t
       LEFT JOIN customer c ON c.id = t.customerid
       ORDER BY t.sortts, t.id`,
      q.values,
    );

    return toPage(
      rows,
      limit,
      row => ({
        id: str(row.id),
        orderNo: str(row.ordernumber),
        status: str(row.status),
        customerName: str(row.customername),
        itemCount: num(row.itemcount),
        deliveryDate: (row.deliverydate as Date | null) ?? null,
      }),
      row => [str(row.sortkey), str(row.id)],
    );
  }

  // ─── Logistics lists ──────────────────────────────────────────────────────

  /** Open pickups, earliest requested date first — so missed ones lead. */
  private async pickupPage(
    storeIds: string[],
    today: Date,
    cursor: Cursor | null,
    limit: number,
  ): Promise<Page<PickupRow>> {
    if (!storeIds.length) return EMPTY_PAGE;

    const q = new SqlParams();
    const sortKey = `COALESCE(pr.requesteddate, 'infinity'::timestamptz)`;
    const conditions = [
      // pickup_request.storeid is a text column, unlike orders.storeid.
      `pr.storeid = ANY(${q.add(storeIds)}::text[])`,
      'pr.isdeleted IS NOT TRUE',
      `pr.status = ANY(${q.add(OPEN_PICKUP_STATUSES)}::text[])`,
    ];
    if (cursor) {
      conditions.push(
        `(${sortKey}, pr.id) > (${q.add(cursor.k)}::timestamptz, ${q.add(cursor.id)}::uuid)`,
      );
    }

    const rows: Row[] = await this.dataSource.execute(
      `SELECT pr.id, pr.pickupnumber, pr.customername, pr.requesteddate, pr.slot, pr.status,
              ${sortKey}::text AS sortkey
       FROM pickup_request pr
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${sortKey}, pr.id
       LIMIT ${q.add(limit + 1)}`,
      q.values,
    );

    return toPage(
      rows,
      limit,
      row => {
        const requestedDate = (row.requesteddate as Date | null) ?? null;
        return {
          id: str(row.id),
          pickupNumber: str(row.pickupnumber),
          customerName: str(row.customername),
          requestedDate,
          slot: str(row.slot),
          status: str(row.status),
          missed: Boolean(requestedDate && new Date(requestedDate) < today),
        };
      },
      row => [str(row.sortkey), str(row.id)],
    );
  }

  /** Tickets that left on a delivery run inside the window, newest first. */
  private async deliveryPage(
    storeIds: string[],
    window: DashboardWindow,
    cursor: Cursor | null,
    limit: number,
  ): Promise<Page<DeliveryRow>> {
    if (!storeIds.length) return EMPTY_PAGE;

    const q = new SqlParams();
    const conditions = [
      `d.storeid = ANY(${q.add(storeIds)}::uuid[])`,
      'd.isdeleted IS NOT TRUE',
      `d.startedat BETWEEN ${q.add(window.from)} AND ${q.add(window.to)}`,
    ];
    if (cursor) {
      conditions.push(
        `(d.startedat, dor.id) < (${q.add(cursor.k)}::timestamptz, ${q.add(cursor.id)}::uuid)`,
      );
    }

    const rows: Row[] = await this.dataSource.execute(
      `SELECT dor.id, dor.orderid, dor.ordernumber, dor.customername, d.ridername, d.startedat,
              d.startedat::text AS sortkey
       FROM delivery d
       JOIN delivery_order dor ON dor.deliveryid = d.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.startedat DESC, dor.id DESC
       LIMIT ${q.add(limit + 1)}`,
      q.values,
    );

    return toPage(
      rows,
      limit,
      row => ({
        id: str(row.id),
        orderId: str(row.orderid),
        orderNo: str(row.ordernumber),
        customerName: str(row.customername),
        riderName: str(row.ridername),
        dispatchedAt: (row.startedat as Date | null) ?? null,
      }),
      row => [str(row.sortkey), str(row.id)],
    );
  }

  /**
   * One row per rider-assignment currently occupying a rider: an active
   * pickup, or an undelivered ticket carrying a delivery rider. Not date
   * scoped — this is what each rider is holding right now.
   */
  private riderLoadsSql(q: SqlParams, storeIds: string[]): string {
    return `
      SELECT pr.assignedriderid::text AS riderid, pr.assignedridername AS ridername,
             1 AS pickups, 0 AS deliveries
      FROM pickup_request pr
      WHERE pr.storeid = ANY(${q.add(storeIds)}::text[])
        AND pr.isdeleted IS NOT TRUE
        AND pr.assignedriderid IS NOT NULL
        AND pr.status = ANY(${q.add(ACTIVE_RIDER_PICKUP_STATUSES)}::text[])
      UNION ALL
      SELECT o.assignedriderid::text, o.assignedridername, 0, 1
      FROM orders o
      WHERE o.storeid = ANY(${q.add(storeIds)}::uuid[])
        AND o.isdeleted IS NOT TRUE
        AND o.assignedriderid IS NOT NULL
        AND o.status = ANY(${q.add(OPEN_ORDER_STATUSES)}::text[])`;
  }

  /** Busiest rider first. */
  private async riderPage(
    storeIds: string[],
    cursor: Cursor | null,
    limit: number,
  ): Promise<Page<RiderRow>> {
    if (!storeIds.length) return EMPTY_PAGE;

    const q = new SqlParams();
    const loads = this.riderLoadsSql(q, storeIds);
    const after = cursor
      ? `WHERE total < ${q.add(Number(cursor.k))} OR (total = ${q.add(Number(cursor.k))} AND riderid > ${q.add(cursor.id)})`
      : '';

    const rows: Row[] = await this.dataSource.execute(
      `WITH grouped AS (
         SELECT riderid, MAX(ridername) AS ridername,
                SUM(pickups)::int AS pickups, SUM(deliveries)::int AS deliveries,
                SUM(pickups + deliveries)::int AS total
         FROM (${loads}) loads
         GROUP BY riderid
       )
       SELECT * FROM grouped
       ${after}
       ORDER BY total DESC, riderid ASC
       LIMIT ${q.add(limit + 1)}`,
      q.values,
    );

    return toPage(
      rows,
      limit,
      row => ({
        riderId: str(row.riderid),
        riderName: str(row.ridername) || 'Assigned rider',
        pickups: num(row.pickups),
        deliveries: num(row.deliveries),
      }),
      row => [String(num(row.total)), str(row.riderid)],
    );
  }
}
