import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {get, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {OrderStatus} from '../models/order-status.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {RiderRosterType} from '../models/rider-roster-type.enum';
import {
  OrderRepository,
  PickupRequestRepository,
  RiderAttendanceRepository,
  RiderRepository,
  RiderRosterRepository,
  UsersRepository,
} from '../repositories';

// Derived availability states. `on-delivery` covers BOTH an active pickup run
// (rider_assigned/out_for_pickup on a PickupRequest) and an active delivery
// leg (an Order assigned to this rider, queued or already out for delivery) —
// one shared value, not split, since the caller already knows which screen
// it's looking from; the practical question this endpoint answers is just
// "is this rider free to hand a new job to right now."
type AvailabilityStatus = 'available' | 'on-break' | 'off-duty' | 'on-delivery';

/**
 * Rider availability — a live, read-only dashboard of each rider's current
 * status, computed (not stored) from attendance + today's roster:
 *
 *   on leave / week-off now      → off-duty   (scheduled off, wins over everything)
 *   punched in + on break now   → on-break
 *   punched in + active pickup/delivery run → on-delivery
 *   punched in, otherwise       → available
 *   not punched in              → off-duty
 *
 * Everything reflects real system state — nothing is self-reported.
 */
export class RiderAvailabilityController {
  constructor(
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RiderAttendanceRepository)
    private attendanceRepository: RiderAttendanceRepository,
    @repository(RiderRosterRepository)
    private rosterRepository: RiderRosterRepository,
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
  ) {}

  private edgeAt(date: string, time: string | undefined, fallback: string): number {
    const t = /^\d{2}:\d{2}/.test(time ?? '') ? (time as string).slice(0, 5) : fallback;
    return new Date(`${String(date).slice(0, 10)}T${t}:00`).getTime();
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider:read']})
  @get('/riders/availability')
  @response(200, {description: 'Live availability for every active rider'})
  async availability(): Promise<object> {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    const riders = await this.riderRepository.find({
      where: {isDeleted: false, isActive: true},
      order: ['riderCode ASC'],
    });
    if (!riders.length) return {riders: []};

    const riderIds = riders.map(r => r.id);
    const userIds = [...new Set(riders.map(r => r.userId).filter(Boolean))];

    // Batched — no per-rider queries.
    const [users, openSessions, todaysRosters, activePickups, activeDeliveryOrders] = await Promise.all([
      userIds.length
        ? this.usersRepository.find({
            where: {id: {inq: userIds}} as object,
            fields: {id: true, phone: true, countryCode: true, fullName: true} as object,
          })
        : Promise.resolve([]),
      // Open attendance = on the clock (no punch-out yet).
      this.attendanceRepository.find({
        where: {riderId: {inq: riderIds}, punchOutAt: {eq: null}, isDeleted: false} as object,
      }),
      // Roster entries whose date range covers today; time is checked below.
      this.rosterRepository.find({
        where: {
          riderId: {inq: riderIds},
          isDeleted: false,
          startDate: {lte: today},
          endDate: {gte: today},
        } as object,
      }),
      // Active pickup runs — rider has been handed the job but not yet back at the store.
      this.pickupRequestRepository.find({
        where: {
          assignedRiderId: {inq: riderIds},
          isDeleted: false,
          status: {inq: [PickupRequestStatus.RIDER_ASSIGNED, PickupRequestStatus.OUT_FOR_PICKUP]},
        } as object,
        fields: {id: true, assignedRiderId: true} as object,
      }),
      // Active delivery legs — queued (READY/PARTIALLY_DISPATCHED with a rider
      // already on it) or already out the door.
      this.orderRepository.find({
        where: {
          assignedRiderId: {inq: riderIds},
          isDeleted: false,
          status: {inq: [OrderStatus.READY, OrderStatus.PARTIALLY_DISPATCHED, OrderStatus.OUT_FOR_DELIVERY]},
        } as object,
        fields: {id: true, assignedRiderId: true} as object,
      }),
    ]);

    const userById = new Map(users.map(u => [u.id, u]));
    const openByRider = new Map(openSessions.map(s => [s.riderId, s]));
    const busyRiderIds = new Set<string>([
      ...activePickups.map(p => p.assignedRiderId).filter((id): id is string => Boolean(id)),
      ...activeDeliveryOrders.map(o => o.assignedRiderId).filter((id): id is string => Boolean(id)),
    ]);

    // Governing roster entry per rider, if one is active right this moment.
    const rosterByRider = new Map<string, (typeof todaysRosters)[number]>();
    for (const r of todaysRosters) {
      const start = this.edgeAt(r.startDate, r.startTime, '00:00');
      const end = this.edgeAt(r.endDate, r.endTime, '23:59');
      if (now < start || now > end) continue; // in date range but not the time window

      const current = rosterByRider.get(r.riderId);
      // Off-scheduled types (leave / week-off) take precedence over a break.
      const weight = (t: RiderRosterType) =>
        t === RiderRosterType.LEAVE || t === RiderRosterType.WEEK_OFF ? 2 : t === RiderRosterType.BREAK ? 1 : 0;
      if (!current || weight(r.rosterType as RiderRosterType) > weight(current.rosterType as RiderRosterType)) {
        rosterByRider.set(r.riderId, r);
      }
    }

    const rows = riders.map(rider => {
      const user = userById.get(rider.userId);
      const openSession = openByRider.get(rider.id);
      const roster = rosterByRider.get(rider.id);

      let status: AvailabilityStatus;
      let lastUpdatedAt: Date | null;

      const scheduledOff =
        roster?.rosterType === RiderRosterType.LEAVE ||
        roster?.rosterType === RiderRosterType.WEEK_OFF;
      const onBreak = roster?.rosterType === RiderRosterType.BREAK;

      if (scheduledOff) {
        status = 'off-duty';
        lastUpdatedAt = roster?.updatedAt ?? null;
      } else if (openSession && onBreak) {
        status = 'on-break';
        lastUpdatedAt = roster?.updatedAt ?? openSession.punchInAt ?? null;
      } else if (openSession && busyRiderIds.has(rider.id)) {
        status = 'on-delivery';
        lastUpdatedAt = openSession.punchInAt ?? null;
      } else if (openSession) {
        status = 'available';
        lastUpdatedAt = openSession.punchInAt ?? null;
      } else {
        status = 'off-duty';
        lastUpdatedAt = null;
      }

      return {
        riderId: rider.id,
        riderCode: rider.riderCode,
        name: `${rider.firstName ?? ''} ${rider.lastName ?? ''}`.trim(),
        riderType: rider.riderType,
        phone: user?.phone ?? null,
        countryCode: user?.countryCode ?? null,
        status,
        lastUpdatedAt,
        // Live GPS belongs to Track Rider (separate). Address is a placeholder.
        location: rider.address ?? null,
      };
    });

    return {riders: rows};
  }
}
