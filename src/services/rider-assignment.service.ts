import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PickupDeliverySlot} from '../models/pickup-delivery-slot.model';
import {RiderRoster} from '../models/rider-roster.model';
import {RiderRosterType} from '../models/rider-roster-type.enum';
import {PickupDeliverySlotRepository, RiderPincodeMappingRepository, RiderRosterRepository} from '../repositories';

// Roster types that make a rider unassignable for whatever window they
// cover — everything else (work, other) leaves assignability untouched.
const BLOCKING_ROSTER_TYPES = [
  RiderRosterType.LEAVE,
  RiderRosterType.WEEK_OFF,
  RiderRosterType.BREAK,
  RiderRosterType.PERMISSION,
];

const ROSTER_TYPE_LABEL: Record<string, string> = {
  [RiderRosterType.LEAVE]: 'on leave',
  [RiderRosterType.WEEK_OFF]: 'on a week off',
  [RiderRosterType.BREAK]: 'on a break',
  [RiderRosterType.PERMISSION]: 'on permission',
};

/**
 * Shared guards for handing a rider new work — used by both
 * order.controller.ts (delivery assignment) and pickup-request.controller.ts
 * (pickup assignment) so the two flows can't drift apart.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class RiderAssignmentService {
  constructor(
    @repository(RiderPincodeMappingRepository)
    private riderPincodeMappingRepository: RiderPincodeMappingRepository,
    @repository(RiderRosterRepository)
    private riderRosterRepository: RiderRosterRepository,
    @repository(PickupDeliverySlotRepository)
    private pickupDeliverySlotRepository: PickupDeliverySlotRepository,
  ) {}

  // Combines a roster row's date (startDate/endDate) with its optional
  // "HH:mm" time-of-day (startTime/endTime) into a real timestamp — same
  // logic as RiderAvailabilityController.edgeAt, generalized here since
  // this service checks an arbitrary future window, not just "right now".
  private edgeAt(date: string, time: string | undefined, fallback: string): number {
    const t = /^\d{2}:\d{2}/.test(time ?? '') ? (time as string).slice(0, 5) : fallback;
    return new Date(`${String(date).slice(0, 10)}T${t}:00`).getTime();
  }

  /**
   * Resolves a job's own scheduled window — the actual thing a rider's
   * roster is checked against, not "right now" (a job assigned this
   * morning for a 4–6pm slot must check the rider's roster for 4–6pm, not
   * 10am). Given a slot id, uses that PickupDeliverySlot's startTime/
   * endTime combined with dateStr's date. Without one: a caller that
   * already has a precise instant (e.g. Order.deliveryDate, a full
   * date-time) should pass it as fallbackInstant so the check stays tight;
   * a caller with only a bare date (e.g. PickupRequest's date-only
   * scheduledDate) should omit it, falling back to the whole day.
   */
  async resolveSlotWindow(
    dateStr: string,
    slotId?: string,
    fallbackInstant?: number,
  ): Promise<{start: number; end: number}> {
    if (slotId) {
      const slot: PickupDeliverySlot | null = await this.pickupDeliverySlotRepository.findOne({
        where: {id: slotId, isDeleted: false} as object,
      });
      if (slot) {
        return {
          start: this.edgeAt(dateStr, slot.startTime, '00:00'),
          end: this.edgeAt(dateStr, slot.endTime, '23:59'),
        };
      }
    }
    if (fallbackInstant != null) return {start: fallbackInstant, end: fallbackInstant};
    return {
      start: this.edgeAt(dateStr, undefined, '00:00'),
      end: this.edgeAt(dateStr, undefined, '23:59'),
    };
  }

  /**
   * Bulk version — for each of the given riders, the roster row that makes
   * them unavailable (leave/week-off/break/permission) for ANY part of the
   * window, if any. Powers both assertRiderRostered below (single rider,
   * throws) and the assignment dropdowns' own filtering
   * (RiderAvailabilityController.availabilityForSlot), so "who's excluded
   * from the list" and "who gets rejected on submit" can never disagree.
   */
  async findRosterBlockingEntries(
    riderIds: string[],
    window: {start: number; end: number},
  ): Promise<Map<string, RiderRoster>> {
    const blocking = new Map<string, RiderRoster>();
    if (!riderIds.length) return blocking;

    const startDate = new Date(window.start).toISOString().slice(0, 10);
    const endDate = new Date(window.end).toISOString().slice(0, 10);

    const rosters = await this.riderRosterRepository.find({
      where: {
        riderId: {inq: riderIds},
        isDeleted: false,
        rosterType: {inq: BLOCKING_ROSTER_TYPES},
        startDate: {lte: endDate},
        endDate: {gte: startDate},
      } as object,
    });

    for (const roster of rosters) {
      if (blocking.has(roster.riderId)) continue;
      const rosterStart = this.edgeAt(roster.startDate, roster.startTime, '00:00');
      const rosterEnd = this.edgeAt(roster.endDate, roster.endTime, '23:59');
      if (window.start <= rosterEnd && window.end >= rosterStart) blocking.set(roster.riderId, roster);
    }
    return blocking;
  }

  /**
   * Blocks assigning a job to a rider who is on leave, a week off, a
   * break, or permission for ANY part of the job's own scheduled window
   * (see resolveSlotWindow) — roster is the only gate now; a rider with
   * other active pickups/deliveries is assignable without limit (multi-job
   * capacity, not blocked here anymore).
   */
  async assertRiderRostered(riderId: string, window: {start: number; end: number}): Promise<void> {
    const blocking = await this.findRosterBlockingEntries([riderId], window);
    const roster = blocking.get(riderId);
    if (roster) {
      const label = ROSTER_TYPE_LABEL[roster.rosterType] ?? roster.rosterType;
      throw new HttpErrors.Conflict(`This rider is ${label} during this slot and cannot be assigned.`);
    }
  }

  /** Blocks assigning a job to a rider who isn't mapped to cover its pincode. */
  async assertRiderCoversPincode(riderId: string, pincode?: string | null): Promise<void> {
    if (!pincode) return;
    const mapping = await this.riderPincodeMappingRepository.findOne({
      where: {riderId, pincode, isActive: true, isDeleted: false} as object,
    });
    if (!mapping) {
      throw new HttpErrors.BadRequest(`This rider is not mapped to pincode ${pincode}.`);
    }
  }
}
