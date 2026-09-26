import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RiderNotification} from '../models';
import {RiderNotificationRepository, RiderRepository} from '../repositories';

export class RiderNotificationController {
  constructor(
    @repository(RiderNotificationRepository)
    private riderNotificationRepository: RiderNotificationRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
  ) {}

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  // ─── Admin panel ────────────────────────────────────────────────────────
  // Generic filter pass-through, same convention as rider-pincode-mapping
  // .controller.ts's find()/count() — the admin panel narrows by riderId
  // (or type/deliveryStatus) via filter.where, same as any other list.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_notification:read']})
  @get('/rider-notifications/count')
  @response(200, {description: 'Rider notification count'})
  async count(@param.query.object('where') where?: object): Promise<{count: number}> {
    return this.riderNotificationRepository.count(where as object);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_notification:read']})
  @get('/rider-notifications')
  @response(200, {description: 'Rider notifications sent'})
  async find(
    @param.filter(RiderNotification) filter?: Filter<RiderNotification>,
  ): Promise<RiderNotification[]> {
    return this.riderNotificationRepository.find({
      order: ['createdAt DESC'],
      ...filter,
      include: [{relation: 'rider'}],
    });
  }

  // ─── Rider app (self-service) ───────────────────────────────────────────

  @authenticate('jwt')
  @get('/rider/notifications')
  @response(200, {description: "The calling rider's own notifications"})
  async myNotifications(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.number('skip') skip = 0,
    @param.query.number('limit') limit = 25,
  ): Promise<{notifications: RiderNotification[]; totalCount: number; unreadCount: number}> {
    const rider = await this.resolveActiveRider(currentUser);
    const cappedLimit = Math.min(Math.max(limit, 1), 100);

    const [notifications, {count: totalCount}, {count: unreadCount}] = await Promise.all([
      this.riderNotificationRepository.find({
        where: {riderId: rider.id},
        order: ['createdAt DESC'],
        skip: Math.max(skip, 0),
        limit: cappedLimit,
      }),
      this.riderNotificationRepository.count({riderId: rider.id}),
      this.riderNotificationRepository.count({riderId: rider.id, isRead: false}),
    ]);

    return {notifications, totalCount, unreadCount};
  }

  @authenticate('jwt')
  @patch('/rider/notifications/{id}/read')
  @response(204, {description: 'Notification marked read'})
  async markRead(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<void> {
    const rider = await this.resolveActiveRider(currentUser);
    const notification = await this.riderNotificationRepository.findOne({where: {id}});
    if (!notification || notification.riderId !== rider.id) {
      throw new HttpErrors.NotFound('Notification not found.');
    }
    if (notification.isRead) return;
    await this.riderNotificationRepository.updateById(id, {isRead: true, readAt: new Date()});
  }
}
