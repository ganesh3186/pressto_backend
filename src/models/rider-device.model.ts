import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Rider} from './rider.model';

/**
 * One FCM-registered device for a rider — deliberately a separate table
 * (not a single fcmToken column on Rider) so a rider can be signed in on
 * more than one device at once, e.g. a phone and a tablet, without one
 * login silently kicking the other off notifications.
 *
 * A token is unique to one physical app install, never to a rider — see
 * NotificationService.registerDevice(), which reassigns a token found on
 * a DIFFERENT rider rather than leaving two riders pointed at the same
 * device (a reinstalled/handed-down phone would otherwise keep notifying
 * whoever used it last).
 */
@model({
  settings: {
    postgresql: {table: 'rider_device', schema: 'public'},
    indexes: {
      uniqueFcmToken: {keys: ['fcmToken'], options: {unique: true}},
    },
  },
})
export class RiderDevice extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Rider)
  riderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  fcmToken: string;

  // 'android' | 'ios' | 'web' — plain string, not an enum: purely informational
  // (nothing branches on it today), and app-reported values shouldn't be able
  // to fail validation server-side.
  @property({type: 'string'})
  platform?: string;

  @property({type: 'string'})
  appVersion?: string;

  // Cleared (not deleted) when a send to this token comes back
  // unregistered/invalid — see NotificationService.dispatch(). Kept as a
  // row, not removed, so the registration history survives for debugging.
  @property({type: 'boolean', default: true})
  isActive?: boolean;

  // Refreshed on every login and every explicit re-register — lets a
  // future cleanup job age out devices nobody has opened the app on in
  // months, without needing to guess from isActive alone.
  @property({type: 'date', defaultFn: 'now'})
  lastSeenAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<RiderDevice>) {
    super(data);
  }
}

export interface RiderDeviceRelations {}

export type RiderDeviceWithRelations = RiderDevice & RiderDeviceRelations;
