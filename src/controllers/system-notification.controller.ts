import { authenticate, AuthenticationBindings } from '@loopback/authentication';
import { inject } from '@loopback/core';
import {
  Filter,
  repository,
  Where,
} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { SystemNotification } from '../models/system-notification.model';
import { SystemNotificationRepository } from '../repositories/system-notification.repository';
import { SystemNotificationService } from '../services/system-notification.service';
import { CurrentUser } from '../types';

export class SystemNotificationController {
  constructor(
    @repository(SystemNotificationRepository)
    public systemNotificationRepository: SystemNotificationRepository,
    @inject('services.system-notification')
    public systemNotificationService: SystemNotificationService,
  ) { }

  /**
   * Get all notifications for the currently authenticated user.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:read'] })
  @get('/system-notifications')
  @response(200, {
    description: 'Notifications for the current user',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            notifications: {
              type: 'array',
              items: getModelSchemaRef(SystemNotification),
            },
            unreadCount: { type: 'number' },
            allCount: { type: 'number' },
          },
        },
      },
    },
  })
  async getMyNotifications(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: CurrentUser,
    @param.filter(SystemNotification) filter?: Filter<SystemNotification>,
  ): Promise<{
    success: boolean;
    notifications: SystemNotification[];
    unreadCount: number;
    allCount: number;
  }> {
    const userId = currentUser.id;
    if (!userId) {
      throw new HttpErrors.Unauthorized('User not authenticated');
    }

    const baseWhere: Where<SystemNotification> = {
      userId,
      isDeleted: false,
    };

    const combinedFilter: Filter<SystemNotification> = {
      ...filter,
      where: filter?.where
        ? { and: [baseWhere, filter.where] }
        : baseWhere,
      order: filter?.order ?? ['createdAt DESC'],
    };

    const [notifications, unreadCount, allCount] = await Promise.all([
      this.systemNotificationRepository.find(combinedFilter),
      this.systemNotificationRepository.count({ userId, status: 0, isDeleted: false }),
      this.systemNotificationRepository.count({ userId, isDeleted: false }),
    ]);

    return {
      success: true,
      notifications,
      unreadCount: unreadCount.count,
      allCount: allCount.count,
    };
  }

  /**
   * Mark all unread notifications as read for current user.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:update'] })
  @patch('/system-notifications/mark-as-read')
  @response(200, {
    description: 'Mark all notifications as read',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            count: { type: 'number' },
          },
        },
      },
    },
  })
  async markAllAsRead(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: CurrentUser,
  ): Promise<{ success: boolean; message: string; count: number }> {
    const userId = currentUser.id;
    if (!userId) {
      throw new HttpErrors.Unauthorized('User not authenticated');
    }

    const result = await this.systemNotificationRepository.updateAll(
      { status: 1 },
      { userId, status: 0, isDeleted: false },
    );

    return {
      success: true,
      message: 'All notifications marked as read',
      count: result.count,
    };
  }

  /**
   * Mark a single notification as read.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:update'] })
  @patch('/system-notifications/{id}/mark-as-read')
  @response(200, {
    description: 'Mark a single notification as read',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
  })
  async markAsReadById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: CurrentUser,
  ): Promise<{ success: boolean; message: string }> {
    const notification = await this.systemNotificationRepository.findById(id);
    if (!notification || notification.isDeleted) {
      throw new HttpErrors.NotFound('Notification not found');
    }

    const isSuperAdmin = currentUser.roles?.includes('super_admin');
    if (notification.userId !== currentUser.id && !isSuperAdmin) {
      throw new HttpErrors.Forbidden('You do not have permission to update this notification');
    }

    await this.systemNotificationRepository.updateById(id, { status: 1 });

    return {
      success: true,
      message: 'Notification marked as read',
    };
  }

  /**
   * SuperAdmin / Management endpoint: Create notification manually.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:create'] })
  @post('/system-notifications')
  @response(200, {
    description: 'Create a system notification',
    content: { 'application/json': { schema: getModelSchemaRef(SystemNotification) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(SystemNotification, {
            title: 'NewSystemNotification',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    notification: Omit<SystemNotification, 'id'>,
  ): Promise<SystemNotification> {
    return this.systemNotificationRepository.create(notification);
  }

  /**
   * SuperAdmin / Management endpoint: Broadcast notification to all superadmins.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:create'] })
  @post('/system-notifications/broadcast-super-admins')
  @response(200, {
    description: 'Broadcast notification to all super admins',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'number' },
          },
        },
      },
    },
  })
  async broadcastSuperAdmins(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['title', 'body', 'template'],
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              template: { type: 'string' },
              pathname: { type: 'string' },
              extraDetails: { type: 'object' },
              remark: { type: 'string' },
            },
          },
        },
      },
    })
    payload: {
      title: string;
      body: string;
      template: string;
      pathname?: string;
      extraDetails?: Record<string, any>;
      remark?: string;
    },
  ): Promise<{ success: boolean; count: number }> {
    const created = await this.systemNotificationService.notifySuperAdmins(payload);
    return {
      success: true,
      count: created.length,
    };
  }

  /**
   * SuperAdmin / Management endpoint: View all notifications across all users.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:read'] })
  @get('/system-notifications/all')
  @response(200, {
    description: 'All system notifications (admin query)',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(SystemNotification),
        },
      },
    },
  })
  async findAll(
    @param.filter(SystemNotification) filter?: Filter<SystemNotification>,
  ): Promise<SystemNotification[]> {
    return this.systemNotificationRepository.find({
      ...filter,
      where: filter?.where
        ? { and: [{ isDeleted: false }, filter.where] }
        : { isDeleted: false },
      order: filter?.order ?? ['createdAt DESC'],
    });
  }

  /**
   * Get single notification by ID.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:read'] })
  @get('/system-notifications/{id}')
  @response(200, {
    description: 'System notification details',
    content: { 'application/json': { schema: getModelSchemaRef(SystemNotification) } },
  })
  async findById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: CurrentUser,
  ): Promise<SystemNotification> {
    const notification = await this.systemNotificationRepository.findById(id);
    if (!notification || notification.isDeleted) {
      throw new HttpErrors.NotFound('Notification not found');
    }

    const isSuperAdmin = currentUser.roles?.includes('super_admin');
    const hasReadPerm = currentUser.permissions?.includes('system_notification:read');
    if (notification.userId !== currentUser.id && !isSuperAdmin && !hasReadPerm) {
      throw new HttpErrors.Forbidden('You do not have access to this notification');
    }

    return notification;
  }

  /**
   * Soft delete a notification.
   */
  @authenticate('jwt')
  @authorize({ roles: ['super_admin'], permissions: ['system_notification:delete'] })
  @del('/system-notifications/{id}')
  @response(204, { description: 'System notification deleted' })
  async deleteById(
    @param.path.string('id') id: string,
  ): Promise<void> {
    await this.systemNotificationRepository.updateById(id, {
      isDeleted: true,
      deletedAt: new Date(),
    });
  }
}
