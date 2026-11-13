import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {OrderStatus} from '../models/order-status.enum';
import {OrderRepository, StoreRepository} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

/** Widest receiving-date window a challan may cover, in days. */
const MAX_RANGE_DAYS = 366;

/** Hard cap on item lines — a challan is a printable sheet, not an export dump. */
const MAX_LINES = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * One row per order line of a QSST ticket (an order carrying an itpvId)
 * that is READY at the store — i.e. processed and waiting, never delivered,
 * out for delivery, cancelled or anything else. Lines rejected at intake
 * never became garments, so they are left off the sheet.
 *
 * Item/service names prefer the order-line snapshot over the catalog row,
 * same as the rest of the app, so a later catalog rename never rewrites
 * what was physically received.
 */
const QSST_CHALLAN_SQL = `
SELECT
  oi.id                                         AS "id",
  o.id                                          AS "orderId",
  o.ordernumber                                 AS "orderNumber",
  btrim(o.itpvid)                               AS "ticketNo",
  o.createdat                                   AS "receivingDate",
  o.deliverydate                                AS "deliveryDate",
  (o.reprocessoforderid IS NOT NULL)            AS "isRecleaning",
  COALESCE(NULLIF(oi.itemname, ''), i.name, '—') AS "itemName",
  COALESCE(NULLIF(oi.servicename, ''), sv.name, '—') AS "serviceName",
  sc.id                                         AS "serviceCategoryId",
  COALESCE(sc.name, 'Uncategorised')            AS "serviceCategoryName",
  oi.quantity::int                              AS "quantity",
  NULLIF(btrim(concat_ws(' ', c.firstname, c.lastname)), '') AS "customerName"
FROM public.orders o
JOIN public.order_item oi ON oi.orderid = o.id
LEFT JOIN public.service sv ON sv.id = oi.serviceid
LEFT JOIN public.service_category sc ON sc.id::text = sv.servicecategoryid
LEFT JOIN public.item i ON i.id = oi.itemid
LEFT JOIN public.customer c ON c.id = o.customerid
WHERE o.storeid = $1::uuid
  AND o.isdeleted = false
  AND o.status = $2
  AND o.itpvid IS NOT NULL AND btrim(o.itpvid) <> ''
  AND o.createdat BETWEEN $3 AND $4
  AND COALESCE(oi.rejectedatintake, false) = false
  AND oi.quantity > 0
  AND ($5::text IS NULL OR sv.servicecategoryid = $5::text)
ORDER BY sc.name NULLS LAST, length(btrim(o.itpvid)), btrim(o.itpvid), oi.createdat, oi.id
LIMIT $6`;

type QsstChallanRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  ticketNo: string;
  receivingDate: Date | null;
  deliveryDate: Date | null;
  isRecleaning: boolean;
  itemName: string;
  serviceName: string;
  serviceCategoryId: string | null;
  serviceCategoryName: string;
  quantity: number;
  customerName: string | null;
};

/**
 * QSST Intra-store Challan — the "Inter Store Transfer Challan" sheet a store
 * sends with its ready QSST garments. Read-only: nothing is persisted, the
 * challan is generated on demand from live order state.
 */
export class QsstChallanController {
  constructor(
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['transfer:read']})
  @get('/intra-store/qsst-challan')
  @response(200, {
    description: 'Ready QSST ticket lines for the intra-store challan',
  })
  async generate(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('serviceCategoryId') serviceCategoryId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    if (!storeId || !UUID.test(storeId)) {
      throw new HttpErrors.BadRequest('Select a store.');
    }
    if (serviceCategoryId && !UUID.test(serviceCategoryId)) {
      throw new HttpErrors.BadRequest('serviceCategoryId is not valid.');
    }

    // Narrow within what the caller can already see — never widen it.
    const scope = await this.storeScopeService.resolve(currentUser);
    if (!scope.global && !scope.storeIds.includes(storeId)) {
      throw new HttpErrors.Forbidden('You do not have access to this store.');
    }

    const {from, to} = resolveWindow(dateFrom, dateTo);

    const store = await this.storeRepo.findOne({
      where: {id: storeId, isDeleted: false} as object,
      fields: {id: true, name: true, code: true} as object,
    });
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const raw = (await this.orderRepo.execute(QSST_CHALLAN_SQL, [
      storeId,
      OrderStatus.READY,
      from,
      to,
      serviceCategoryId ? serviceCategoryId : null,
      MAX_LINES + 1,
    ])) as QsstChallanRow[];

    const truncated = raw.length > MAX_LINES;
    const rows = (truncated ? raw.slice(0, MAX_LINES) : raw).map(row => ({
      ...row,
      id: String(row.id),
      orderId: String(row.orderId),
      serviceCategoryId: row.serviceCategoryId
        ? String(row.serviceCategoryId)
        : null,
      quantity: Number(row.quantity) || 0,
      isRecleaning: Boolean(row.isRecleaning),
    }));

    return {
      challan: {
        store: {id: String(store.id), name: store.name, code: store.code},
        dateFrom: from,
        dateTo: to,
        rows,
        totalLines: rows.length,
        totalItems: rows.reduce((sum, row) => sum + row.quantity, 0),
        truncated,
      },
    };
  }
}

/**
 * A bare `YYYY-MM-DD` is read as LOCAL midnight (new Date(str) would read
 * it as UTC and shift the window), and `dateTo` covers its whole day.
 */
function resolveWindow(
  dateFrom?: string,
  dateTo?: string,
): {from: Date; to: Date} {
  if (!dateFrom || !dateTo) {
    throw new HttpErrors.BadRequest('dateFrom and dateTo are required.');
  }
  const from = parseLocal(dateFrom);
  const to = parseLocal(dateTo);
  if (Number.isNaN(from.getTime()))
    throw new HttpErrors.BadRequest('dateFrom is not a valid date.');
  if (Number.isNaN(to.getTime()))
    throw new HttpErrors.BadRequest('dateTo is not a valid date.');
  if (CALENDAR_DATE.test(dateTo)) to.setHours(23, 59, 59, 999);
  if (to < from)
    throw new HttpErrors.BadRequest(
      'To date must not be earlier than From date.',
    );
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new HttpErrors.BadRequest(
      `Date range must not exceed ${MAX_RANGE_DAYS} days.`,
    );
  }
  return {from, to};
}

function parseLocal(value: string): Date {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return new Date(value);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    0,
    0,
    0,
  );
}
