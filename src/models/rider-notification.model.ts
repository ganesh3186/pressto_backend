import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Rider} from './rider.model';

/**
 * Append-only history of every notification a rider was sent — the
 * authoritative "what did we tell this rider and when" record, independent
 * of whether the FCM push actually reached a device. Written once per
 * NotificationService.notifyRider() call, regardless of whether the rider
 * had any active device or Firebase was even configured — a rider who
 * never opened the app yet, or whose token expired, still has the event on
 * record here, and still sees it once they do open a notification list.
 *
 * One row per notification EVENT, not per device — a rider signed into two
 * devices gets one row here even though the underlying push may go to two
 * tokens (see RiderDevice).
 */
@model({
  settings: {postgresql: {table: 'rider_notification', schema: 'public'}},
})
export class RiderNotification extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Rider)
  riderId: string;

  // One of RIDER_NOTIFICATION_TYPES (notification.service.ts) — plain
  // string, not an enum: the app switches on it to route/deep-link, and
  // new types shouldn't need a migration to add.
  @property({type: 'string', required: true})
  type: string;

  @property({type: 'string', required: true})
  title: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  body: string;

  // Same extra fields sent in the FCM data payload (e.g. pickupRequestId,
  // orderId, transferId) — lets a notification-list tap deep-link the same
  // way a live push would, even well after the push itself is gone.
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  data?: Record<string, string>;

  // Whether the FCM push itself actually went out — independent of
  // isRead/readAt below, which track the rider's own interaction with this
  // row once they see it in-app.
  //   sent    — reached at least one active device successfully.
  //   failed  — Firebase was configured and the rider had device(s), but
  //             every send attempt failed.
  //   skipped — nothing to send to: Firebase not configured yet, or the
  //             rider has no active registered device.
  @property({
    type: 'string',
    default: 'skipped',
    jsonSchema: {enum: ['sent', 'failed', 'skipped']},
  })
  deliveryStatus?: string;

  @property({type: 'boolean', default: false})
  isRead?: boolean;

  @property({type: 'date'})
  readAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<RiderNotification>) {
    super(data);
  }
}

export interface RiderNotificationRelations {}

export type RiderNotificationWithRelations = RiderNotification & RiderNotificationRelations;
