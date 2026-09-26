import * as fs from 'fs';
import {App, cert, initializeApp} from 'firebase-admin/app';
import {getMessaging, MulticastMessage, SendResponse} from 'firebase-admin/messaging';
import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {RiderDeviceRepository} from '../repositories';

/**
 * A rider-facing push notification — deliberately DATA-ONLY (no top-level
 * `notification` block in the FCM message), so the rider app decides how
 * (and whether) to surface it, including while killed. `type` is a stable
 * string the app switches on to route/deep-link (see NOTIFICATION_TYPES
 * below); title/body are still sent, just inside `data`, for the app to
 * render itself rather than letting the OS render Firebase's own payload.
 */
export interface RiderNotification {
  type: string;
  title: string;
  body: string;
  /** Extra fields for the app to act on, e.g. pickupRequestId, orderId. Values are stringified — FCM data payloads are string-only. */
  data?: Record<string, string | number | undefined | null>;
}

export const RIDER_NOTIFICATION_TYPES = {
  PICKUP_ASSIGNED: 'pickup_assigned',
  PICKUP_REASSIGNED: 'pickup_reassigned',
  PICKUP_CANCELLED: 'pickup_cancelled',
  DELIVERY_ASSIGNED: 'delivery_assigned',
  DELIVERY_REASSIGNED: 'delivery_reassigned',
  DELIVERY_CANCELLED: 'delivery_cancelled',
  TRANSFER_ASSIGNED: 'transfer_assigned',
  TRANSFER_REASSIGNED: 'transfer_reassigned',
  TRANSFER_CANCELLED: 'transfer_cancelled',
} as const;

/**
 * Rider push notifications via Firebase Cloud Messaging. Tokens live in
 * RiderDevice (one row per app install, see that model — a rider can have
 * several), not on Rider itself.
 *
 * Firebase credentials (FIREBASE_SERVICE_ACCOUNT_PATH) are optional at
 * boot: the client hadn't handed over the service account key yet at the
 * time this was built, and the app must still start and run normally
 * without it. initializeFirebase() logs one warning and every send
 * becomes a no-op until a real key file is placed — see
 * firebase-service-account.json.placeholder for where.
 */
@injectable({scope: BindingScope.SINGLETON})
export class NotificationService {
  private app: App | null = null;
  private warnedMissingCredentials = false;

  constructor(
    @repository(RiderDeviceRepository) private riderDeviceRepo: RiderDeviceRepository,
  ) {
    this.initializeFirebase();
  }

  private initializeFirebase(): void {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? './firebase-service-account.json';
    if (!fs.existsSync(path)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[NotificationService] No Firebase service account found at "${path}" — rider push ` +
          'notifications are disabled until it is added (see firebase-service-account.json.placeholder).',
      );
      return;
    }
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(path, 'utf8'));
      this.app = initializeApp({credential: cert(serviceAccount)});
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NotificationService] Failed to initialize Firebase — push notifications disabled.', error);
    }
  }

  private get ready(): boolean {
    if (this.app) return true;
    if (!this.warnedMissingCredentials) {
      this.warnedMissingCredentials = true;
      // eslint-disable-next-line no-console
      console.warn('[NotificationService] Skipping send — Firebase is not configured yet.');
    }
    return false;
  }

  /**
   * Registers or refreshes a device's FCM token — called at rider login
   * (verify-otp) and by the app's own token-refresh call. A token belongs
   * to one physical install, never to a rider: if this exact token is
   * already on record for a DIFFERENT rider (a handed-down or reinstalled
   * phone), it's reassigned rather than left pointed at whoever used it
   * last.
   */
  async registerDevice(
    riderId: string,
    fcmToken: string,
    options: {platform?: string; appVersion?: string} = {},
  ): Promise<void> {
    if (!fcmToken?.trim()) return;
    const token = fcmToken.trim();

    const existing = await this.riderDeviceRepo.findOne({where: {fcmToken: token}});
    const patch = {
      riderId,
      platform: options.platform,
      appVersion: options.appVersion,
      isActive: true,
      lastSeenAt: new Date(),
    };
    if (existing) {
      await this.riderDeviceRepo.updateById(existing.id, patch);
      return;
    }
    const {v4} = await import('uuid');
    await this.riderDeviceRepo.create({id: v4(), fcmToken: token, ...patch});
  }

  /**
   * Sends to every active device this rider is currently signed into.
   * Never throws — a push failure must not roll back or block the
   * assignment/status-change that triggered it; errors are logged and
   * swallowed. A token FCM reports as unregistered/invalid is deactivated
   * so future sends stop wasting a call on it.
   */
  async notifyRider(riderId: string, notification: RiderNotification): Promise<void> {
    if (!this.ready) return;

    try {
      const devices = await this.riderDeviceRepo.find({where: {riderId, isActive: true}});
      if (!devices.length) return;

      const data: Record<string, string> = {
        type: notification.type,
        title: notification.title,
        body: notification.body,
      };
      Object.entries(notification.data ?? {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) data[key] = String(value);
      });

      const message: MulticastMessage = {
        tokens: devices.map(d => d.fcmToken),
        data,
      };
      const response = await getMessaging(this.app!).sendEachForMulticast(message);
      await Promise.all(
        response.responses.map(async (result: SendResponse, index: number) => {
          if (result.success) return;
          const code = result.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            await this.riderDeviceRepo.updateById(devices[index].id, {isActive: false});
          }
        }),
      );
    } catch (error) {
      // Whole method is guarded, not just the Firebase call — a DB error
      // resolving devices must not throw either, so this can be called
      // fire-and-forget-safely from anywhere without a .catch().
      // eslint-disable-next-line no-console
      console.error(`[NotificationService] Failed to notify rider ${riderId}.`, error);
    }
  }
}
