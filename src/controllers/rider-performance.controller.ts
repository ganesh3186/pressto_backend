import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {
  DeliveryRepository,
  PaymentTransactionRepository,
  PickupHandoverRepository,
  PickupRequestRepository,
  RiderCashHandoverRepository,
  RiderRepository,
} from '../repositories';

const MAX_RANGE_DAYS = 366;

function toDateKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

// PickupRequest.requestedDate is stored date-only, so a plain 'to' string
// bounds it exactly. Every other field here (deliveryDate/paymentDate/
// submittedAt) is a real timestamp — bounding by midnight would silently
// exclude same-day records with any time-of-day component, so those
// queries need the boundary pushed to the end of the 'to' day instead.
function endOfDay(dateKey: string): string {
  return `${dateKey}T23:59:59.999Z`;
}

/**
 * Rider-facing "Work Summary" and "Performance" screens. Both are pure
 * read/aggregate views over data this app already tracks elsewhere
 * (PickupRequest/Delivery/PaymentTransaction/handover batches) — no new
 * tracking was added to support them; there's no distance/time-worked/
 * rating data anywhere in this system yet, so those aren't in scope.
 */
export class RiderPerformanceController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @repository(PickupRequestRepository) private pickupRequestRepository: PickupRequestRepository,
    @repository(DeliveryRepository) private deliveryRepository: DeliveryRepository,
    @repository(PaymentTransactionRepository)
    private paymentTransactionRepository: PaymentTransactionRepository,
    @repository(RiderCashHandoverRepository)
    private riderCashHandoverRepository: RiderCashHandoverRepository,
    @repository(PickupHandoverRepository) private pickupHandoverRepository: PickupHandoverRepository,
  ) {}

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  // Both endpoints below default to "today only" when the caller sends no
  // dates — matches the app's own date pickers, which start pre-filled to
  // today rather than empty.
  private resolveDateRange(fromDate?: string, toDate?: string): {from: string; to: string} {
    const todayKey = toDateKey(new Date());
    const from = fromDate ?? todayKey;
    const to = toDate ?? todayKey;
    if (new Date(from).toString() === 'Invalid Date' || new Date(to).toString() === 'Invalid Date') {
      throw new HttpErrors.BadRequest('fromDate/toDate must be valid dates.');
    }
    if (from > to) throw new HttpErrors.BadRequest('fromDate must not be after toDate.');
    const days = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new HttpErrors.BadRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`);
    }
    return {from, to};
  }

  // ─── Work Summary — one row per day ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/work-summary')
  @response(200, {description: "The calling rider's own day-by-day work summary"})
  async workSummary(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('fromDate') fromDate?: string,
    @param.query.string('toDate') toDate?: string,
    // Matches against each row's display date (dd-mm-yyyy) — there's no
    // customer/order-level text on a day-aggregate row to search by.
    @param.query.string('search') search?: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const {from, to} = this.resolveDateRange(fromDate, toDate);
    const toEnd = endOfDay(to);

    const [pickups, deliveries, transactions, cashHandovers, pickupHandovers] = await Promise.all([
      this.pickupRequestRepository.find({
        where: {
          assignedRiderId: rider.id,
          isDeleted: false,
          requestedDate: {between: [from, to]},
          status: {inq: [PickupRequestStatus.PICKED_UP, PickupRequestStatus.RECEIVED_AT_STORE]},
        } as object,
        fields: {requestedDate: true} as object,
      }),
      this.deliveryRepository.find({
        where: {
          riderId: rider.id,
          isDeleted: false,
          deliveryDate: {between: [from, toEnd]},
          status: DeliveryStatus.COMPLETED,
        } as object,
        fields: {deliveryDate: true} as object,
      }),
      this.paymentTransactionRepository.find({
        where: {riderId: rider.id, paymentDate: {between: [from, toEnd]}} as object,
        fields: {paymentDate: true, amount: true} as object,
      }),
      this.riderCashHandoverRepository.find({
        where: {riderId: rider.id, isDeleted: false, submittedAt: {between: [from, toEnd]}} as object,
        fields: {submittedAt: true} as object,
      }),
      this.pickupHandoverRepository.find({
        where: {riderId: rider.id, isDeleted: false, submittedAt: {between: [from, toEnd]}} as object,
        fields: {submittedAt: true} as object,
      }),
    ]);

    type DayRow = {
      date: string;
      pickupsCompleted: number;
      deliveriesCompleted: number;
      cashCollected: number;
      cashHandoversSubmitted: number;
      pickupHandoversSubmitted: number;
    };
    const byDay = new Map<string, DayRow>();
    for (let cursor = new Date(`${from}T00:00:00.000Z`); toDateKey(cursor) <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const key = toDateKey(cursor);
      byDay.set(key, {
        date: key,
        pickupsCompleted: 0,
        deliveriesCompleted: 0,
        cashCollected: 0,
        cashHandoversSubmitted: 0,
        pickupHandoversSubmitted: 0,
      });
    }

    for (const p of pickups) {
      const row = byDay.get(toDateKey(p.requestedDate));
      if (row) row.pickupsCompleted += 1;
    }
    for (const d of deliveries) {
      if (!d.deliveryDate) continue;
      const row = byDay.get(toDateKey(d.deliveryDate));
      if (row) row.deliveriesCompleted += 1;
    }
    for (const t of transactions) {
      if (!t.paymentDate) continue;
      const row = byDay.get(toDateKey(t.paymentDate));
      if (row) row.cashCollected += Number(t.amount) || 0;
    }
    for (const h of cashHandovers) {
      const row = byDay.get(toDateKey(h.submittedAt));
      if (row) row.cashHandoversSubmitted += 1;
    }
    for (const h of pickupHandovers) {
      const row = byDay.get(toDateKey(h.submittedAt));
      if (row) row.pickupHandoversSubmitted += 1;
    }

    let days = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    if (search?.trim()) {
      const term = search.trim().toLowerCase();
      days = days.filter(d => {
        const [y, m, dd] = d.date.split('-');
        return `${dd}-${m}-${y}`.includes(term) || d.date.includes(term);
      });
    }

    return {fromDate: from, toDate: to, days};
  }

  // ─── Performance — completion counts + rate, per tab ─────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/performance')
  @response(200, {description: "The calling rider's own completion performance for pickups or deliveries"})
  async performance(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('type') type: 'pickup' | 'delivery',
    @param.query.string('fromDate') fromDate?: string,
    @param.query.string('toDate') toDate?: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    if (type !== 'pickup' && type !== 'delivery') {
      throw new HttpErrors.BadRequest('type must be "pickup" or "delivery".');
    }
    const {from, to} = this.resolveDateRange(fromDate, toDate);

    let assigned: number;
    let completed: number;
    let cancelled: number;

    if (type === 'pickup') {
      const pickups = await this.pickupRequestRepository.find({
        where: {assignedRiderId: rider.id, isDeleted: false, requestedDate: {between: [from, to]}} as object,
        fields: {status: true} as object,
      });
      assigned = pickups.length;
      completed = pickups.filter(
        p => p.status === PickupRequestStatus.PICKED_UP || p.status === PickupRequestStatus.RECEIVED_AT_STORE,
      ).length;
      cancelled = pickups.filter(p => p.status === PickupRequestStatus.CANCELLED).length;
    } else {
      const deliveries = await this.deliveryRepository.find({
        where: {riderId: rider.id, isDeleted: false, deliveryDate: {between: [from, endOfDay(to)]}} as object,
        fields: {status: true} as object,
      });
      assigned = deliveries.length;
      completed = deliveries.filter(d => d.status === DeliveryStatus.COMPLETED).length;
      cancelled = deliveries.filter(d => d.status === DeliveryStatus.CANCELLED).length;
    }

    const completionRate = assigned > 0 ? Math.round((completed / assigned) * 10000) / 100 : 0;

    return {type, fromDate: from, toDate: to, assigned, completed, cancelled, completionRate};
  }
}
