import {HttpErrors} from '@loopback/rest';

// Roles that can never be granted or revoked through generic employee/customer
// role management. super_admin is created exactly once via
// POST /auth/super-admin/register, which itself refuses a second registration —
// that invariant must hold everywhere else too, or the system ends up with
// multiple super admins (or, worse, someone accidentally strips the role from
// the only super admin while editing an unrelated employee record).
export const PROTECTED_ROLES = ['super_admin'];

export function assertNoProtectedRoles(roleValues: string[] | undefined): void {
  if (!roleValues?.length) return;
  const found = roleValues.find(v => PROTECTED_ROLES.includes(v));
  if (found) {
    throw new HttpErrors.Forbidden(
      `The "${found}" role cannot be assigned through employee/customer management. ` +
        `It is reserved for the single super admin created at initial system setup.`,
    );
  }
}

// Customer-app-only roles. They carry no admin-panel permissions, so they must
// never be picked as "the" role for a staff login session.
export const NON_STAFF_ROLES = ['client', 'customer'];

// A user linked as both employee and customer (see EmployeeController.create /
// CustomerController.create's linkExistingAccount flow) holds both roles on
// one login. user.roles comes back in whatever order the DB join happens to
// return — not necessarily insertion order — so blindly taking roles[0] can
// land on the customer role for someone logging into the *staff* app,
// leaving them with zero admin-panel permissions despite being real staff.
// Always prefer whichever role actually has admin-panel meaning.
export function pickStaffRole<T extends {value: string}>(roles: T[]): T {
  return roles.find(r => !NON_STAFF_ROLES.includes(r.value)) ?? roles[0];
}

// Mirror image for the customer app: a dual-linked login authenticating
// through customer OTP must always present as "customer" first, never as
// whatever staff role the same login also happens to hold. Keeps every role
// in the list (some callers may still care the login is also staff) but
// guarantees index 0 — "the" role for display purposes — is the customer one.
export function sortCustomerRoleFirst<T extends {value: string}>(roles: T[]): T[] {
  return [...roles].sort((a, b) => {
    const aIsCustomer = NON_STAFF_ROLES.includes(a.value) ? 0 : 1;
    const bIsCustomer = NON_STAFF_ROLES.includes(b.value) ? 0 : 1;
    return aIsCustomer - bIsCustomer;
  });
}
