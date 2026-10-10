import {UserProfile} from '@loopback/security';

/** Dashboard sections reuse the permissions of their corresponding modules. */
export function dashboardAccess(user: UserProfile) {
  const has = (permission: string) =>
    user.roles?.includes('super_admin') ||
    user.permissions?.includes(permission) ||
    false;
  const enabled = has('dashboard:read');
  return {
    tickets: enabled && has('order:read'),
    pickups: enabled && has('pickup_request:read'),
    deliveries: enabled && has('delivery:read'),
    riders: enabled && has('rider:read'),
    collected: enabled && has('invoice:read'),
    handover: enabled && has('rider_cash_handover:read'),
  };
}

export type DashboardAccess = ReturnType<typeof dashboardAccess>;

