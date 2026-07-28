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
