import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Rider} from './rider.model';
import {RiderRosterType} from './rider-roster-type.enum';

/**
 * One scheduled block on a rider's duty chart — a work shift, leave, week-off,
 * break, etc. Availability reads today's active entries to decide whether a
 * rider is off-duty or on-break.
 *
 * Dates and times are kept separate, matching the form: a date range plus an
 * optional "HH:mm" time window within it.
 */
@model({
  settings: {
    postgresql: {
      table: 'rider_roster',
      schema: 'public',
    },
  },
})
export class RiderRoster extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Rider)
  riderId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(RiderRosterType)},
  })
  rosterType: RiderRosterType;

  @property({type: 'date', required: true})
  startDate: string;

  @property({type: 'date', required: true})
  endDate: string;

  // "HH:mm" — the time window within the date range.
  @property({type: 'string'})
  startTime?: string;

  @property({type: 'string'})
  endTime?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  description?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<RiderRoster>) {
    super(data);
  }
}

export interface RiderRosterRelations {
  rider?: Rider;
}

export type RiderRosterWithRelations = RiderRoster & RiderRosterRelations;
