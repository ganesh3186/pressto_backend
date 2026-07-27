import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Rider} from './rider.model';

/**
 * One attendance session for a rider: a punch-in, and later a punch-out. Each is
 * proven by a selfie taken in the app and stamped with the server time.
 *
 * A row with no `punchOutAt` is an open session (the rider is on the clock).
 */
@model({
  settings: {
    postgresql: {
      table: 'rider_attendance',
      schema: 'public',
    },
  },
})
export class RiderAttendance extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Rider)
  riderId: string;

  // ── Punch in ──────────────────────────────────────────────────────────────
  @property({type: 'date', required: true})
  punchInAt: Date;

  // Selfie proving the rider was present at punch-in — a Media record id.
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  punchInMediaId: string;

  @property({type: 'number', postgresql: {dataType: 'decimal'}})
  punchInLatitude?: number;

  @property({type: 'number', postgresql: {dataType: 'decimal'}})
  punchInLongitude?: number;

  // ── Punch out (filled when the session closes) ──────────────────────────────
  @property({type: 'date'})
  punchOutAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  punchOutMediaId?: string;

  @property({type: 'number', postgresql: {dataType: 'decimal'}})
  punchOutLatitude?: number;

  @property({type: 'number', postgresql: {dataType: 'decimal'}})
  punchOutLongitude?: number;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<RiderAttendance>) {
    super(data);
  }
}

export interface RiderAttendanceRelations {
  rider?: Rider;
}

export type RiderAttendanceWithRelations = RiderAttendance & RiderAttendanceRelations;
