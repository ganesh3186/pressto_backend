import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, repository} from '@loopback/repository';
import {del, get, getModelSchemaRef, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RiderRoster} from '../models';
import {RiderRosterType} from '../models/rider-roster-type.enum';
import {RiderRepository, RiderRosterRepository} from '../repositories';

interface RosterBody {
  riderId: string;
  rosterType: RiderRosterType;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  description?: string;
}

/** Request-body schema. Standalone so it can be used in @requestBody decorators. */
function rosterSchema(includeRider: boolean) {
  const properties: Record<string, object> = {
    rosterType: {type: 'string', enum: Object.values(RiderRosterType)},
    startDate: {type: 'string', format: 'date'},
    endDate: {type: 'string', format: 'date'},
    startTime: {type: 'string', description: 'HH:mm'},
    endTime: {type: 'string', description: 'HH:mm'},
    description: {type: 'string'},
  };
  if (includeRider) properties.riderId = {type: 'string', format: 'uuid'};
  return {
    type: 'object' as const,
    required: includeRider
      ? ['riderId', 'rosterType', 'startDate', 'endDate']
      : ['rosterType', 'startDate', 'endDate'],
    properties,
  };
}

export class RiderRosterController {
  constructor(
    @repository(RiderRosterRepository)
    private rosterRepository: RiderRosterRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
  ) {}

  // ─── Validation helpers ───────────────────────────────────────────────────

  private toDateOnly(value: string): string {
    // Accepts "2026-07-22" or a full ISO string; keeps just the date part.
    return String(value).slice(0, 10);
  }

  /** Full timestamp for an edge of an entry, defaulting the time when absent. */
  private edgeAt(date: string, time: string | undefined, fallback: string): number {
    const t = /^\d{2}:\d{2}/.test(time ?? '') ? time!.slice(0, 5) : fallback;
    return new Date(`${this.toDateOnly(date)}T${t}:00`).getTime();
  }

  private startAt(e: {startDate: string; startTime?: string}): number {
    return this.edgeAt(e.startDate, e.startTime, '00:00');
  }

  private endAt(e: {endDate: string; endTime?: string}): number {
    return this.edgeAt(e.endDate, e.endTime, '23:59');
  }

  /**
   * Mirrors the form's Yup rules, enforced server-side so the API is safe on its
   * own. `isCreate` skips the past-date check on edits (you may adjust an entry
   * that started earlier).
   */
  private validateWindow(body: RosterBody, isCreate: boolean) {
    if (!Object.values(RiderRosterType).includes(body.rosterType)) {
      throw new HttpErrors.BadRequest(`Invalid roster type: ${body.rosterType}`);
    }
    const start = this.toDateOnly(body.startDate);
    const end = this.toDateOnly(body.endDate);
    if (end < start) {
      throw new HttpErrors.BadRequest('End date cannot be before start date.');
    }
    if (isCreate) {
      const today = new Date().toISOString().slice(0, 10);
      if (start < today) {
        throw new HttpErrors.BadRequest('Roster cannot start in the past.');
      }
    }
    // On a same-day window, end time must be after start time.
    if (start === end && body.startTime && body.endTime && body.endTime <= body.startTime) {
      throw new HttpErrors.BadRequest('End time must be after start time.');
    }
  }

  /**
   * Rejects a clash with an existing entry of the SAME type for the same rider.
   * Different types may overlap on purpose — a break sits inside a work shift —
   * but two leaves (or two work shifts) covering the same time is a mistake.
   */
  private async assertNoOverlap(body: RosterBody, ignoreId?: string) {
    const start = this.toDateOnly(body.startDate);
    const end = this.toDateOnly(body.endDate);

    // Candidates: same rider + type, active, whose date range could intersect.
    const candidates = await this.rosterRepository.find({
      where: {
        riderId: body.riderId,
        rosterType: body.rosterType,
        isDeleted: false,
        startDate: {lte: end},
        endDate: {gte: start},
      } as object,
    });

    const newStart = this.startAt(body);
    const newEnd = this.endAt(body);
    for (const c of candidates) {
      if (ignoreId && c.id === ignoreId) continue;
      // Half-open overlap: touching edges (one ends exactly when the next begins) is fine.
      if (newStart < this.endAt(c) && newEnd > this.startAt(c)) {
        throw new HttpErrors.Conflict(
          `This ${body.rosterType} overlaps an existing ${body.rosterType} entry for this rider.`,
        );
      }
    }
  }

  private async assertRiderExists(riderId: string) {
    const rider = await this.riderRepository.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:create']})
  @post('/rider-rosters')
  @response(200, {description: 'Roster entry created'})
  async create(
    @requestBody({content: {'application/json': {schema: rosterSchema(true)}}})
    body: RosterBody,
  ): Promise<object> {
    await this.assertRiderExists(body.riderId);
    this.validateWindow(body, true);
    await this.assertNoOverlap(body);

    const {v4} = await import('uuid');
    const roster = await this.rosterRepository.create({id: v4(), ...body});
    return {message: 'Roster entry created.', roster};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:read']})
  @get('/rider-rosters')
  @response(200, {description: 'Roster entries with the rider'})
  async find(@param.filter(RiderRoster) filter?: Filter<RiderRoster>): Promise<RiderRoster[]> {
    return this.rosterRepository.find({
      ...filter,
      where: {...filter?.where, isDeleted: false},
      include: [{relation: 'rider'}],
      order: filter?.order ?? ['startDate DESC'],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:read']})
  @get('/rider-rosters/{id}')
  @response(200, {
    description: 'One roster entry',
    content: {'application/json': {schema: getModelSchemaRef(RiderRoster, {includeRelations: true})}},
  })
  async findById(@param.path.string('id') id: string): Promise<RiderRoster> {
    const roster = await this.rosterRepository.findOne({
      where: {id, isDeleted: false},
      include: [{relation: 'rider'}],
    });
    if (!roster) throw new HttpErrors.NotFound('Roster entry not found.');
    return roster;
  }

  /** One rider's schedule — the per-rider roster view. */
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:read']})
  @get('/riders/{id}/rosters')
  @response(200, {description: 'A rider’s roster entries'})
  async forRider(@param.path.string('id') riderId: string): Promise<object> {
    await this.assertRiderExists(riderId);
    const rosters = await this.rosterRepository.find({
      where: {riderId, isDeleted: false},
      order: ['startDate DESC'],
    });
    return {count: rosters.length, rosters};
  }

  /** The signed-in rider's own schedule, for the rider app. */
  @authenticate('jwt')
  @get('/profile/rider/rosters')
  @response(200, {description: 'My roster entries'})
  async myRosters(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('No rider profile for this account.');
    const rosters = await this.rosterRepository.find({
      where: {riderId: rider.id, isDeleted: false},
      order: ['startDate DESC'],
    });
    return {count: rosters.length, rosters};
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:update']})
  @patch('/rider-rosters/{id}')
  @response(200, {description: 'Roster entry updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({content: {'application/json': {schema: rosterSchema(false)}}})
    body: Omit<RosterBody, 'riderId'>,
  ): Promise<object> {
    const existing = await this.rosterRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Roster entry not found.');

    // The rider is fixed once created; the rest is merged over the current entry
    // so validation and overlap see the full picture.
    const merged: RosterBody = {
      riderId: existing.riderId,
      rosterType: body.rosterType ?? existing.rosterType,
      startDate: body.startDate ?? existing.startDate,
      endDate: body.endDate ?? existing.endDate,
      startTime: body.startTime ?? existing.startTime,
      endTime: body.endTime ?? existing.endTime,
      description: body.description ?? existing.description,
    };
    this.validateWindow(merged, false);
    await this.assertNoOverlap(merged, id);

    await this.rosterRepository.updateById(id, {
      rosterType: merged.rosterType,
      startDate: merged.startDate,
      endDate: merged.endDate,
      startTime: merged.startTime,
      endTime: merged.endTime,
      description: merged.description,
    });
    return {message: 'Roster entry updated.'};
  }

  // ─── Soft delete ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_roster:delete']})
  @del('/rider-rosters/{id}')
  @response(200, {description: 'Roster entry deleted'})
  async deleteById(@param.path.string('id') id: string): Promise<object> {
    const existing = await this.rosterRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Roster entry not found.');
    await this.rosterRepository.updateById(id, {
      isDeleted: true,
      deletedAt: new Date() as unknown as Date,
    });
    return {message: 'Roster entry deleted.'};
  }
}
