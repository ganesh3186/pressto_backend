import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {DashboardService} from '../services/dashboard.service';
import {StoreScopeService} from '../services/store-scope.service';
import {
  DASHBOARD_LISTS,
  DashboardList,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  StoreDashboardService,
} from '../services/store-dashboard.service';

/** Widest window the dashboard will aggregate over, in days. */
const MAX_RANGE_DAYS = 31;

/**
 * Store dashboard — one read-only aggregate behind the landing screen, so
 * the client makes a single call instead of one per panel.
 *
 * Every figure is store-scoped by StoreScopeService: `storeId` is a
 * NARROWING filter intersected against the stores the caller can already
 * see, never a lookup key. A store user naming another store gets an
 * empty summary rather than that store data; omitting it falls back to
 * the caller full scope, which is what makes this correct for
 * cluster- and region-scoped roles without any extra branching.
 */
export class DashboardController {
  constructor(
    @inject('services.dashboard') private dashboardService: DashboardService,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @inject('services.store-dashboard') private storeDashboardService: StoreDashboardService,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['dashboard:read']})
  @get('/dashboard/store-summary')
  @response(200, {description: 'Every store dashboard panel in one payload'})
  async storeSummary(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);

    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});

    // narrowStoreIds returns null only for a global caller who asked for
    // no particular store. Aggregating every store in the business is not
    // something this screen is built to show (and would scan the whole
    // orders table), so make the client pick one.
    if (storeIds === null) {
      throw new HttpErrors.BadRequest(
        'Select a store — storeId is required for accounts that can see every store.',
      );
    }

    const summary = await this.dashboardService.buildStoreSummary(storeIds, from, to);
    return {summary};
  }

  // ─── Paged dashboard ──────────────────────────────────────────────────────
  //
  // The landing screen loads with two calls — `live` (ignores the date
  // range) and `window` (follows it) — so changing the date never refetches
  // the live lists. Each returns true counts plus the first page of every
  // list; "Show more" on one card then calls `lists/{list}` for that card
  // alone.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['dashboard:read']})
  @get('/dashboard/live')
  @response(200, {description: 'Live store figures and first page of each live list'})
  async live(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.number('limit') limit?: number,
  ): Promise<object> {
    const storeIds = await this.resolveStoreIds(currentUser, storeId);
    return this.storeDashboardService.live(storeIds, resolveLimit(limit));
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['dashboard:read']})
  @get('/dashboard/window')
  @response(200, {description: 'Date-range store figures and first page of each range list'})
  async window(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.number('limit') limit?: number,
  ): Promise<object> {
    const window = resolveWindow(dateFrom, dateTo);
    const storeIds = await this.resolveStoreIds(currentUser, storeId);
    return this.storeDashboardService.window(storeIds, window, resolveLimit(limit));
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['dashboard:read']})
  @get('/dashboard/lists/{list}')
  @response(200, {description: 'The next page of one dashboard list'})
  async listPage(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('list') list: string,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.string('cursor') cursor?: string,
    @param.query.number('limit') limit?: number,
  ): Promise<object> {
    if (!DASHBOARD_LISTS.includes(list)) {
      throw new HttpErrors.NotFound(`Unknown dashboard list "${list}".`);
    }
    // Only the range lists read the window, but validating it for every
    // list keeps a malformed date a 400 regardless of which card asked.
    const window = resolveWindow(dateFrom, dateTo);
    const storeIds = await this.resolveStoreIds(currentUser, storeId);
    return this.storeDashboardService.listPage(
      list as DashboardList,
      storeIds,
      window,
      cursor,
      resolveLimit(limit),
    );
  }

  /** Same scoping rule as storeSummary: a global caller must pick a store. */
  private async resolveStoreIds(currentUser: UserProfile, storeId?: string): Promise<string[]> {
    // The ids end up in a ::uuid[] cast; reject a malformed one as a 400
    // here rather than letting Postgres fail the query with a 500.
    if (storeId && !UUID.test(storeId)) {
      throw new HttpErrors.BadRequest('storeId is not a valid id.');
    }
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});
    if (storeIds === null) {
      throw new HttpErrors.BadRequest(
        'Select a store — storeId is required for accounts that can see every store.',
      );
    }
    return storeIds;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Page size for dashboard lists, clamped so a client cannot ask for everything. */
function resolveLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/**
 * Resolve the reporting window, defaulting to today.
 *
 * A plain `YYYY-MM-DD` is deliberately parsed as LOCAL midnight, not via
 * `new Date(str)` which treats it as UTC — east of UTC that shifts the
 * window forward (in IST by 5.5h) and would drop every order taken
 * between midnight and breakfast. `dateTo` is likewise pushed to the end
 * of its local day, so a single-day range covers that whole day rather
 * than collapsing to one instant at midnight.
 */
function resolveWindow(dateFrom?: string, dateTo?: string): {from: Date; to: Date} {
  const from = dateFrom ? startOfLocalDay(dateFrom) : startOfToday();
  if (Number.isNaN(from.getTime())) {
    throw new HttpErrors.BadRequest('dateFrom is not a valid date.');
  }

  const to = dateTo ? endOfLocalDay(dateTo) : endOfDay(new Date());
  if (Number.isNaN(to.getTime())) {
    throw new HttpErrors.BadRequest('dateTo is not a valid date.');
  }

  if (to < from) {
    throw new HttpErrors.BadRequest('dateTo must not be earlier than dateFrom.');
  }

  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw new HttpErrors.BadRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days.`);
  }

  return {from, to};
}

/** Matches a bare calendar date, the only form the dashboard client sends. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a date param into a local Date. A bare `YYYY-MM-DD` is built
 * field-by-field so it lands on local midnight; anything else (an ISO
 * timestamp with its own offset) is left to the normal Date parser.
 */
function parseLocal(value: string): Date {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
}

function startOfLocalDay(value: string): Date {
  return parseLocal(value);
}

function endOfLocalDay(value: string): Date {
  return endOfDay(parseLocal(value));
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(d: Date): Date {
  if (Number.isNaN(d.getTime())) return d;
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}
