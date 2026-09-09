import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RiderAttendance} from '../models';
import {
  MediaRepository,
  RiderAttendanceRepository,
  RiderRepository,
} from '../repositories';
import {MediaService} from '../services/media.service';

/**
 * Rider attendance — punch in / punch out from the rider app.
 *
 * Punch-in is proven by a selfie the rider takes in the app: it is uploaded
 * first via POST /files (which returns a media id), then that id is sent here.
 * The server stamps the time, so the rider cannot fake when they clocked in.
 * Punch-out does NOT require a selfie — only punch-in needs one to prove
 * identity; `selfieMediaId` on punch-out is accepted but optional.
 *
 * The rider is always resolved from the JWT — a rider can only punch and read
 * their own attendance. An admin view (by rider id) is gated by rider:read.
 */
export class RiderAttendanceController {
  constructor(
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(RiderAttendanceRepository)
    private attendanceRepository: RiderAttendanceRepository,
    @repository(MediaRepository)
    private mediaRepository: MediaRepository,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) {}

  /** The active rider behind the JWT, or a clear error. */
  private async resolveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('No rider profile for this account.');
    if (rider.isActive === false) {
      throw new HttpErrors.Forbidden('This rider account is inactive.');
    }
    return rider;
  }

  /** Rejects a selfie id that is not a real media record. */
  private async assertMediaExists(mediaId: string) {
    const media = await this.mediaRepository.findOne({where: {id: mediaId}});
    if (!media) throw new HttpErrors.BadRequest('Selfie image not found. Upload it first.');
  }

  /** Selfie ids on a set of records → { id: fileUrl }, so responses carry URLs. */
  private async mediaUrlMap(records: RiderAttendance[]): Promise<Record<string, string>> {
    const ids = [
      ...new Set(
        records.flatMap(r => [r.punchInMediaId, r.punchOutMediaId]).filter(Boolean) as string[],
      ),
    ];
    if (!ids.length) return {};
    const media = await this.mediaRepository.find({where: {id: {inq: ids}} as object});
    return Object.fromEntries(media.map(m => [m.id, m.fileUrl]));
  }

  private viewOf(record: RiderAttendance, urls: Record<string, string>) {
    return {
      id: record.id,
      punchInAt: record.punchInAt,
      punchInSelfieUrl: urls[record.punchInMediaId] ?? null,
      punchInLatitude: record.punchInLatitude ?? null,
      punchInLongitude: record.punchInLongitude ?? null,
      punchOutAt: record.punchOutAt ?? null,
      punchOutSelfieUrl: record.punchOutMediaId ? urls[record.punchOutMediaId] ?? null : null,
      punchOutLatitude: record.punchOutLatitude ?? null,
      punchOutLongitude: record.punchOutLongitude ?? null,
      // Open = on the clock; closed = punched out.
      status: record.punchOutAt ? 'punched_out' : 'punched_in',
    };
  }

  /** The rider's currently open session, if any (no punch-out yet). */
  private async openSession(riderId: string) {
    return this.attendanceRepository.findOne({
      // `eq: null` → IS NULL. A bare `undefined` would be stripped from the
      // filter and match every session, open or closed.
      where: {riderId, punchOutAt: {eq: null}, isDeleted: false} as object,
      order: ['punchInAt DESC'],
    });
  }

  // ─── Punch in ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/rider/attendance/punch-in')
  @response(200, {description: 'Rider punched in'})
  async punchIn(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['selfieMediaId'],
            properties: {
              selfieMediaId: {type: 'string', format: 'uuid', description: 'Uploaded via POST /files'},
              latitude: {type: 'number'},
              longitude: {type: 'number'},
            },
          },
        },
      },
    })
    body: {selfieMediaId: string; latitude?: number; longitude?: number},
  ): Promise<object> {
    const rider = await this.resolveRider(currentUser);
    await this.assertMediaExists(body.selfieMediaId);

    // One open session at a time — must punch out before punching in again.
    const open = await this.openSession(rider.id);
    if (open) {
      throw new HttpErrors.Conflict('Already punched in. Punch out before punching in again.');
    }

    const {v4} = await import('uuid');
    const record = await this.attendanceRepository.create({
      id: v4(),
      riderId: rider.id,
      // Server time is the source of truth — the app cannot backdate a punch.
      punchInAt: new Date(),
      punchInMediaId: body.selfieMediaId,
      punchInLatitude: body.latitude,
      punchInLongitude: body.longitude,
    });
    await this.mediaService.updateMediaUsedStatus([body.selfieMediaId], true);

    const urls = await this.mediaUrlMap([record]);
    return {message: 'Punched in.', attendance: this.viewOf(record, urls)};
  }

  // ─── Punch out ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/rider/attendance/punch-out')
  @response(200, {description: 'Rider punched out'})
  async punchOut(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            // No selfie requirement on the way out — only punch-in proves
            // identity with a photo. latitude/longitude stay optional too.
            properties: {
              selfieMediaId: {type: 'string', format: 'uuid', description: 'Uploaded via POST /files (optional)'},
              latitude: {type: 'number'},
              longitude: {type: 'number'},
            },
          },
        },
      },
    })
    body: {selfieMediaId?: string; latitude?: number; longitude?: number},
  ): Promise<object> {
    const rider = await this.resolveRider(currentUser);
    if (body.selfieMediaId) {
      await this.assertMediaExists(body.selfieMediaId);
    }

    const open = await this.openSession(rider.id);
    if (!open) {
      throw new HttpErrors.Conflict('Not punched in. Punch in before punching out.');
    }

    await this.attendanceRepository.updateById(open.id, {
      punchOutAt: new Date(),
      ...(body.selfieMediaId ? {punchOutMediaId: body.selfieMediaId} : {}),
      punchOutLatitude: body.latitude,
      punchOutLongitude: body.longitude,
    });
    if (body.selfieMediaId) {
      await this.mediaService.updateMediaUsedStatus([body.selfieMediaId], true);
    }

    const record = await this.attendanceRepository.findById(open.id);
    const urls = await this.mediaUrlMap([record]);
    return {message: 'Punched out.', attendance: this.viewOf(record, urls)};
  }

  // ─── Current status ─────────────────────────────────────────────────────────
  // Lets the app decide which button to show on launch.

  @authenticate('jwt')
  @get('/profile/rider/attendance/active')
  @response(200, {description: 'The rider’s open session, or null'})
  async active(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const rider = await this.resolveRider(currentUser);
    const open = await this.openSession(rider.id);
    if (!open) return {onDuty: false, attendance: null};
    const urls = await this.mediaUrlMap([open]);
    return {onDuty: true, attendance: this.viewOf(open, urls)};
  }

  // ─── My attendance register ───────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/rider/attendance')
  @response(200, {description: 'The rider’s own attendance history'})
  async myAttendance(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('from') from?: string,
    @param.query.string('to') to?: string,
  ): Promise<object> {
    const rider = await this.resolveRider(currentUser);
    return this.listForRider(rider.id, from, to);
  }

  // ─── Admin: a rider’s register ────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider:read']})
  @get('/riders/{id}/attendance')
  @response(200, {description: 'Attendance history for a rider (admin)'})
  async riderAttendance(
    @param.path.string('id') riderId: string,
    @param.query.string('from') from?: string,
    @param.query.string('to') to?: string,
  ): Promise<object> {
    const rider = await this.riderRepository.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    return this.listForRider(riderId, from, to);
  }

  private async listForRider(riderId: string, from?: string, to?: string) {
    const range: Record<string, Date> = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);

    const records = await this.attendanceRepository.find({
      where: {
        riderId,
        isDeleted: false,
        ...(Object.keys(range).length ? {punchInAt: range} : {}),
      } as object,
      order: ['punchInAt DESC'],
    });

    const urls = await this.mediaUrlMap(records);
    return {
      count: records.length,
      records: records.map(r => this.viewOf(r, urls)),
    };
  }
}
