import { BindingScope, injectable } from '@loopback/core';
import { repository } from '@loopback/repository';
import {
  SystemNotificationRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
  CustomerRepository,
  EmployeeRepository,
  EmployeeStoreRepository,
  PermissionsRepository,
  RolePermissionsRepository,
} from '../repositories';
import { SystemNotification } from '../models/system-notification.model';
import { Order } from '../models/order.model';
import { ApprovalRequest } from '../models/approval-request.model';
import { PickupRequest } from '../models/pickup-request.model';
import { Transfer } from '../models/transfer.model';

export interface NotificationPayload {
  title: string;
  body: string;
  template: string;
  pathname?: string;
  extraDetails?: Record<string, any>;
  remark?: string;
}

@injectable({ scope: BindingScope.SINGLETON })
export class SystemNotificationService {
  constructor(
    @repository(SystemNotificationRepository)
    public systemNotificationRepository: SystemNotificationRepository,
    @repository(RolesRepository)
    public rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    public userRolesRepository: UserRolesRepository,
    @repository(UsersRepository)
    public usersRepository: UsersRepository,
    @repository(CustomerRepository)
    public customerRepository: CustomerRepository,
    @repository(EmployeeRepository)
    public employeeRepository: EmployeeRepository,
    @repository(EmployeeStoreRepository)
    public employeeStoreRepository: EmployeeStoreRepository,
    @repository(PermissionsRepository)
    public permissionsRepository: PermissionsRepository,
    @repository(RolePermissionsRepository)
    public rolePermissionsRepository: RolePermissionsRepository,
  ) { }

  /**
   * Retrieves all active user IDs holding the 'super_admin' role.
   */
  async getSuperAdminUserIds(): Promise<string[]> {
    try {
      const superAdminRole = await this.rolesRepository.findOne({
        where: { value: 'super_admin', isDeleted: false },
      });

      if (!superAdminRole) {
        return [];
      }

      const userRoles = await this.userRolesRepository.find({
        where: { rolesId: superAdminRole.id, isDeleted: false },
      });

      const userIds = userRoles
        .map(ur => ur.usersId)
        .filter((id): id is string => Boolean(id));

      return Array.from(new Set(userIds));
    } catch (error) {
      console.error('Error fetching super admin user IDs:', error);
      return [];
    }
  }

  /**
   * Creates a notification for a specific user.
   */
  async createNotification(
    userId: string,
    payload: NotificationPayload,
  ): Promise<SystemNotification | null> {
    try {
      return await this.systemNotificationRepository.create({
        userId,
        title: payload.title,
        body: payload.body,
        template: payload.template,
        pathname: payload.pathname,
        extraDetails: payload.extraDetails,
        remark: payload.remark,
        status: 0,
        isDeleted: false,
      });
    } catch (error) {
      console.error(`Error creating notification for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Retrieves all active user IDs assigned to a specific store who have
   * permissions to read, create, or update notifications/records for that store.
   */
  async getStoreStaffUserIds(
    storeId: string,
    additionalPermissions: string[] = [],
  ): Promise<string[]> {
    try {
      // 1. Primary store employees
      const primaryEmployees = await this.employeeRepository.find({
        where: { storeId, isDeleted: false, isActive: true },
        fields: { id: true, userId: true },
      });

      // 2. Additional store assignments via employee_store
      const extraMappings = await this.employeeStoreRepository.find({
        where: { storeId, isDeleted: false, isActive: true },
        fields: { employeeId: true },
      });

      let extraUserIds: string[] = [];
      if (extraMappings.length > 0) {
        const extraEmpIds = extraMappings
          .map(m => m.employeeId)
          .filter((id): id is string => Boolean(id));
        if (extraEmpIds.length > 0) {
          const extraEmployees = await this.employeeRepository.find({
            where: { id: { inq: extraEmpIds }, isDeleted: false, isActive: true },
            fields: { userId: true },
          });
          extraUserIds = extraEmployees
            .map(e => e.userId)
            .filter((id): id is string => Boolean(id));
        }
      }

      const candidateUserIds = Array.from(
        new Set([
          ...primaryEmployees
            .map(e => e.userId)
            .filter((id): id is string => Boolean(id)),
          ...extraUserIds,
        ]),
      );

      if (!candidateUserIds.length) {
        return [];
      }

      // 3. Strict Permission checks (read, create, update)
      // If module permissions are required (e.g. order:read/create/update or pickup_request:read/create/update),
      // strictly require the employee to hold at least one of those permissions to receive the alert.
      const targetPermissions =
        additionalPermissions.length > 0
          ? additionalPermissions
          : ['system_notification:read', 'system_notification:create', 'system_notification:update'];

      const perms = await this.permissionsRepository.find({
        where: {
          permission: { inq: targetPermissions },
          isDeleted: false,
        },
      });

      if (!perms.length) {
        return [];
      }

      const permIds = perms.map(p => p.id);
      const rolePerms = await this.rolePermissionsRepository.find({
        where: {
          permissionsId: { inq: permIds },
          isDeleted: false,
        },
      });

      const roleIds = Array.from(
        new Set(rolePerms.map(rp => rp.rolesId).filter((id): id is string => Boolean(id))),
      );

      if (!roleIds.length) {
        return [];
      }

      const userRoles = await this.userRolesRepository.find({
        where: {
          usersId: { inq: candidateUserIds },
          rolesId: { inq: roleIds },
          isDeleted: false,
        },
      });

      const matchedUserIds = Array.from(
        new Set(userRoles.map(ur => ur.usersId).filter((id): id is string => Boolean(id))),
      );

      return matchedUserIds;
    } catch (error) {
      console.error(`Error fetching staff user IDs for store ${storeId}:`, error);
      return [];
    }
  }

  /**
   * Broadcasts a notification to:
   * 1. All active super_admin users (oversee all stores).
   * 2. Active store staff assigned to `storeId` who have notification / resource permissions.
   */
  async notifyUsers(
    payload: NotificationPayload,
    storeId?: string,
    additionalPermissions: string[] = [],
  ): Promise<SystemNotification[]> {
    try {
      const superAdminUserIds = await this.getSuperAdminUserIds();

      let storeStaffUserIds: string[] = [];
      if (storeId) {
        storeStaffUserIds = await this.getStoreStaffUserIds(storeId, additionalPermissions);
      }

      const targetUserIds = Array.from(
        new Set([...superAdminUserIds, ...storeStaffUserIds]),
      );

      if (!targetUserIds.length) {
        return [];
      }

      const notifications = targetUserIds.map(userId => ({
        userId,
        title: payload.title,
        body: payload.body,
        template: payload.template,
        pathname: payload.pathname,
        extraDetails: payload.extraDetails,
        remark: payload.remark,
        status: 0,
        isDeleted: false,
      }));

      return await this.systemNotificationRepository.createAll(notifications);
    } catch (error) {
      console.error('Error broadcasting notification to users:', error);
      return [];
    }
  }

  /**
   * Broadcasts a notification to all active super_admin users.
   */
  async notifySuperAdmins(payload: NotificationPayload): Promise<SystemNotification[]> {
    return this.notifyUsers(payload);
  }

  /**
   * Helper: Resolves customer's full name from customerId if not already supplied.
   */
  private async resolveCustomerName(customerId?: string): Promise<string | undefined> {
    if (!customerId) return undefined;
    try {
      const cust = await this.customerRepository.findById(customerId);
      if (cust) {
        return [cust.firstName, cust.lastName].filter(Boolean).join(' ').trim() || undefined;
      }
    } catch (_) { }
    return undefined;
  }

  /**
   * Trigger: When any order is created.
   */
  async notifyOrderCreated(order: Partial<Order>, customerName?: string): Promise<void> {
    try {
      const orderNum = order.orderNumber ?? order.id;
      const resolvedCustomer = customerName || (await this.resolveCustomerName(order.customerId));
      const custInfo = resolvedCustomer ? ` for customer "${resolvedCustomer}"` : '';
      await this.notifyUsers(
        {
          title: 'New Order Created',
          body: `Order #${orderNum} has been placed${custInfo}.`,
          template: 'order_created',
          pathname: `/dashboard/orders/status/${order.id}`,
          extraDetails: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: resolvedCustomer ?? null,
            storeId: order.storeId,
            totalAmount: order.totalAmount,
          },
        },
        order.storeId,
        ['order:read', 'order:create', 'order:update'],
      );
    } catch (error) {
      console.error('Error in notifyOrderCreated:', error);
    }
  }

  /**
   * Trigger: When an order is ready for delivery (assign rider).
   */
  async notifyOrderReady(order: Partial<Order>, customerName?: string): Promise<void> {
    try {
      const orderNum = order.orderNumber ?? order.id;
      const resolvedCustomer = customerName || (await this.resolveCustomerName(order.customerId));
      const custInfo = resolvedCustomer ? ` for customer "${resolvedCustomer}"` : '';
      await this.notifyUsers(
        {
          title: 'Order Ready for Delivery',
          body: `Order #${orderNum}${custInfo} is packed and ready. Please assign a delivery rider.`,
          template: 'order_ready',
          pathname: `/dashboard/logistics/dispatch`,
          extraDetails: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: resolvedCustomer ?? null,
            storeId: order.storeId,
          },
        },
        order.storeId,
        ['order:read', 'delivery:read', 'delivery:update'],
      );
    } catch (error) {
      console.error('Error in notifyOrderReady:', error);
    }
  }

  /**
   * Trigger: When an approval is required.
   */
  async notifyApprovalRequired(
    approvalRequest: ApprovalRequest,
    details?: string,
  ): Promise<void> {
    try {
      const typeLabel = approvalRequest.type ? approvalRequest.type.replace(/_/g, ' ') : 'General';
      const description =
        details ||
        `A new approval request of type "${typeLabel}" requires review.`;

      await this.notifyUsers({
        title: `Approval Required: ${typeLabel.toUpperCase()}`,
        body: description,
        template: 'approval_required',
        pathname: `/dashboard/orders/approval`,
        extraDetails: {
          approvalRequestId: approvalRequest.id,
          type: approvalRequest.type,
          entityType: approvalRequest.entityType,
          entityId: approvalRequest.entityId,
          assignedToRole: approvalRequest.assignedToRole,
        },
      });
    } catch (error) {
      console.error('Error in notifyApprovalRequired:', error);
    }
  }

  /**
   * Trigger: When a customer books a pickup request from the customer portal/app.
   */
  async notifyCustomerPickupRequested(
    pickupRequest: Partial<PickupRequest>,
    customerName?: string,
  ): Promise<void> {
    try {
      const pickupNum = pickupRequest.pickupNumber ?? pickupRequest.id;
      const resolvedCustomer =
        customerName ||
        pickupRequest.customerName ||
        (await this.resolveCustomerName(pickupRequest.customerId));
      const custInfo = resolvedCustomer ? ` for customer "${resolvedCustomer}"` : '';

      await this.notifyUsers(
        {
          title: 'New Customer Pickup Request',
          body: `Pickup request #${pickupNum} has been booked${custInfo}.`,
          template: 'pickup_requested',
          pathname: `/dashboard/logistics/pickups`,
          extraDetails: {
            pickupRequestId: pickupRequest.id,
            pickupNumber: pickupRequest.pickupNumber,
            customerId: pickupRequest.customerId,
            customerName: resolvedCustomer ?? null,
            storeId: pickupRequest.storeId,
            requestedDate: pickupRequest.requestedDate,
            slot: pickupRequest.slot,
            source: pickupRequest.source,
          },
        },
        pickupRequest.storeId,
        ['pickup_request:read', 'pickup_request:create', 'pickup_request:update'],
      );
    } catch (error) {
      console.error('Error in notifyCustomerPickupRequested:', error);
    }
  }

  /**
   * Trigger: When a customer cancels a pickup request from the customer portal/app.
   */
  async notifyCustomerPickupCancelled(
    pickupRequest: Partial<PickupRequest>,
    customerName?: string,
  ): Promise<void> {
    try {
      const pickupNum = pickupRequest.pickupNumber ?? pickupRequest.id;
      const resolvedCustomer =
        customerName ||
        pickupRequest.customerName ||
        (await this.resolveCustomerName(pickupRequest.customerId));
      const custInfo = resolvedCustomer ? ` by customer "${resolvedCustomer}"` : '';

      await this.notifyUsers(
        {
          title: 'Customer Pickup Request Cancelled',
          body: `Pickup request #${pickupNum} was cancelled${custInfo}.`,
          template: 'pickup_cancelled',
          pathname: `/dashboard/logistics/pickups`,
          extraDetails: {
            pickupRequestId: pickupRequest.id,
            pickupNumber: pickupRequest.pickupNumber,
            customerId: pickupRequest.customerId,
            customerName: resolvedCustomer ?? null,
            storeId: pickupRequest.storeId,
            requestedDate: pickupRequest.requestedDate,
            slot: pickupRequest.slot,
            source: pickupRequest.source,
          },
        },
        pickupRequest.storeId,
        ['pickup_request:read', 'pickup_request:create', 'pickup_request:update'],
      );
    } catch (error) {
      console.error('Error in notifyCustomerPickupCancelled:', error);
    }
  }

  /**
   * Trigger: When a transfer out is created without a rider assigned.
   * Alerts sending store staff (and Super Admins) that a rider needs to be assigned.
   */
  async notifyTransferOutRiderNeeded(
    transfer: Partial<Transfer>,
    fromStoreName?: string,
    toStoreName?: string,
  ): Promise<void> {
    try {
      const transferNum = transfer.transferOrderNumber || transfer.transitId || transfer.id;
      const fromStoreInfo = fromStoreName ? ` from "${fromStoreName}"` : '';
      const toStoreInfo = toStoreName ? ` to "${toStoreName}"` : '';

      await this.notifyUsers(
        {
          title: 'Need to Assign Rider for Transfer Out',
          body: `Transfer Out #${transferNum}${fromStoreInfo}${toStoreInfo} requires a rider to be assigned.`,
          template: 'transfer_assign_rider',
          pathname: '/dashboard/transfer/assign',
          extraDetails: {
            transferId: transfer.id,
            transitId: transfer.transitId,
            transferOrderNumber: transfer.transferOrderNumber,
            fromStoreId: transfer.fromStoreId,
            toStoreId: transfer.toStoreId,
            fromStoreName: fromStoreName ?? null,
            toStoreName: toStoreName ?? null,
          },
        },
        transfer.fromStoreId,
        ['transfer:update', 'transfer:read', 'transfer:create'],
      );
    } catch (error) {
      console.error('Error in notifyTransferOutRiderNeeded:', error);
    }
  }
}



