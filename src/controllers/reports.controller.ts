import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {StoreRepository} from '../repositories';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ReportsService} from '../services/reports.service';
import {StoreScopeService} from '../services/store-scope.service';

/** Widest window any report will aggregate over, in days. */
const MAX_RANGE_DAYS = 366;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Reports — one endpoint per report, each behind its OWN permission
 * (`report_<name>:read`) rather than a single blanket `report:read`.
 *
 * That granularity is the point: the role builder groups permissions by
 * the segment before the colon, so every report shows up as its own row
 * with its own toggle, and a role can be granted the payment report
 * without also seeing, say, on-account billing.
 *
 * Every report is store-scoped through StoreScopeService on the same
 * terms as the rest of the app: `storeId` narrows within what the caller
 * can already see and can never widen it.
 */
export class ReportsController {
  constructor(
    @inject('services.reports') private reportsService: ReportsService,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
    @repository(StoreRepository) private storeRepo: StoreRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_mode_of_payment:read']})
  @get('/reports/mode-of-payment')
  @response(200, {description: 'Mode Of Payment report — one row per payment taken'})
  async modeOfPayment(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    const storeIds = await this.resolveStoreIds(currentUser, storeId);

    const report = await this.reportsService.buildModeOfPayment({
      storeIds,
      from,
      to,
      limit: clampLimit(limit),
      skip: Math.max(0, Number(skip) || 0),
    });
    return {report};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_pending_payments:read']})
  @get('/reports/pending-payments')
  @response(200, {description: 'Pending Payments report — orders still owing money'})
  async pendingPayments(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.string('paymentStatus') paymentStatus?: string,
    @param.query.string('deliveryStatus') deliveryStatus?: string,
    @param.query.string('customerLabelId') customerLabelId?: string,
    @param.query.boolean('includePmu') includePmu?: boolean,
    @param.query.boolean('includeP2d') includeP2d?: boolean,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    const report = await this.reportsService.buildPendingPayments({
      storeIds: await this.resolveStoreIds(currentUser, storeId),
      from,
      to,
      paymentStatus: paymentStatus || 'pending',
      deliveryStatus: deliveryStatus || 'all',
      customerLabelId,
      includePmu,
      includeP2d,
      limit: clampLimit(limit),
      skip: clampSkip(skip),
    });
    return {report};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_pending_tickets:read']})
  @get('/reports/pending-tickets')
  @response(200, {description: 'Pending Tickets report — orders not yet delivered'})
  async pendingTickets(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.boolean('includePmu') includePmu?: boolean,
    @param.query.boolean('includeP2d') includeP2d?: boolean,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    const report = await this.reportsService.buildPendingTickets({
      storeIds: await this.resolveStoreIds(currentUser, storeId),
      from,
      to,
      includePmu,
      includeP2d,
      limit: clampLimit(limit),
      skip: clampSkip(skip),
    });
    return {report};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_on_account_billing:read']})
  @get('/reports/on-account-billing')
  @response(200, {description: 'On Account Billing report — orders billed on account'})
  async onAccountBilling(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.string('deliveryStatus') deliveryStatus?: string,
    @param.query.string('paymentStatus') paymentStatus?: string,
    @param.query.string('customerName') customerName?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    const report = await this.reportsService.buildOnAccountBilling({
      storeIds: await this.resolveStoreIds(currentUser, storeId),
      from,
      to,
      deliveryStatus: deliveryStatus || 'all',
      paymentStatus: paymentStatus || 'all',
      customerName,
      limit: clampLimit(limit),
      skip: clampSkip(skip),
    });
    return {report};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_consolidated_daily_sales:read']})
  @get('/reports/consolidated-daily-sales')
  @response(200, {description: 'Consolidated Daily Sales — closing collections per store per day'})
  async consolidatedDailySales(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    // "Consolidated" means across every store the caller can see, so
    // unlike the per-store reports this one does not force a storeId —
    // omitting it is the normal case, not an error.
    const report = await this.reportsService.buildConsolidatedDailySales({
      storeIds: await this.resolveStoreIdsAllowingAll(currentUser, storeId),
      from,
      to,
    });
    return {report};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['report_petty_cash_expense:read']})
  @get('/reports/petty-cash-expense')
  @response(200, {description: 'Petty Cash Expense report — register entries for the window'})
  async pettyCashExpense(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const {from, to} = resolveWindow(dateFrom, dateTo);
    const report = await this.reportsService.buildPettyCashExpense({
      storeIds: await this.resolveStoreIds(currentUser, storeId),
      from,
      to,
      limit: clampLimit(limit),
      skip: clampSkip(skip),
    });
    return {report};
  }

  /**
   * Narrow the caller's scope to the requested store.
   *
   * `narrowStoreIds` returns null only for a global caller who named no
   * store. Reports are per-store documents (the store name is a column,
   * and the totals are meant to reconcile against one till), so make the
   * client pick one rather than silently blending every store together.
   */
  /**
   * Same narrowing, but a global caller who named no store gets every
   * active store rather than a 400. Only for genuinely cross-store
   * reports; the per-store ones keep requiring an explicit choice.
   */
  private async resolveStoreIdsAllowingAll(
    currentUser: UserProfile,
    storeId?: string,
  ): Promise<string[]> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});
    if (storeIds !== null) return storeIds;

    const stores = await this.storeRepo.find({
      where: {isDeleted: false} as object,
      fields: {id: true} as object,
    });
    return stores.map(s => String(s.id));
  }

  private async resolveStoreIds(
    currentUser: UserProfile,
    storeId?: string,
  ): Promise<string[]> {
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

function clampSkip(skip?: number): number {
  const value = Number(skip);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clampLimit(limit?: number): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

/**
 * Resolve the reporting window. A bare `YYYY-MM-DD` is parsed as LOCAL
 * midnight — `new Date(str)` would read it as UTC, which east of UTC
 * shifts the window forward and drops the early hours of the first day.
 * `dateTo` is pushed to the end of its local day so a single-day range
 * covers that whole day instead of one instant at midnight.
 */
function resolveWindow(dateFrom?: string, dateTo?: string): {from: Date; to: Date} {
  if (!dateFrom || !dateTo) {
    throw new HttpErrors.BadRequest('dateFrom and dateTo are required.');
  }

  const from = parseLocal(dateFrom);
  if (Number.isNaN(from.getTime())) {
    throw new HttpErrors.BadRequest('dateFrom is not a valid date.');
  }

  // A bare YYYY-MM-DD means the whole of that day, so it is pushed to
  // 23:59:59.999. A value that already carries a time (the datetime-local
  // filters on the ticket reports) is honoured as given — extending it to
  // midnight would silently widen a range the user deliberately narrowed.
  const parsedTo = parseLocal(dateTo);
  const to = CALENDAR_DATE.test(dateTo) ? endOfDay(parsedTo) : parsedTo;
  if (Number.isNaN(to.getTime())) {
    throw new HttpErrors.BadRequest('dateTo is not a valid date.');
  }

  if (to < from) {
    throw new HttpErrors.BadRequest('dateTo must not be earlier than dateFrom.');
  }

  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new HttpErrors.BadRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days.`);
  }

  return {from, to};
}

/** Matches a bare calendar date, the form the report filters send. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocal(value: string): Date {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  if (Number.isNaN(d.getTime())) return d;
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}
