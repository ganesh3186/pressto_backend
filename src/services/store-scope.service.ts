import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {
  ClusterRepository,
  EmployeeRepository,
  OrderRepository,
  RolesRepository,
  StoreRepository,
} from '../repositories';

/**
 * Resolved store access for a caller.
 * `global` means every store (no filtering); otherwise only `storeIds` are visible.
 */
export type StoreScope = {
  global: boolean;
  storeIds: string[];
};

/** Sentinel stored in the JWT for callers that may see every store. */
export const STORE_SCOPE_GLOBAL = '*';

/** Roles that are never store-bound (bypass all scope). */
const GLOBAL_ROLES = new Set(['super_admin']);

/** Scope levels a role can declare (Roles.scope). super_admin ignores these. */
type RoleScope = 'store' | 'cluster' | 'region';

const GLOBAL_SCOPE: StoreScope = {global: true, storeIds: []};
/** Fail closed: a bound caller we cannot resolve sees nothing. */
const EMPTY_SCOPE: StoreScope = {global: false, storeIds: []};

@injectable({scope: BindingScope.TRANSIENT})
export class StoreScopeService {
  constructor(
    @repository(EmployeeRepository) private employeeRepo: EmployeeRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(RolesRepository) private rolesRepo: RolesRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
  ) {}

  /**
   * Resolve scope from the database. Called at login to snapshot the scope into the
   * JWT, and as the fallback for tokens issued before store scope existed.
   *
   * The role's `scope` decides which employee binding is authoritative:
   *   store   → the employee's storeId
   *   cluster → every store in the employee's clusterId
   *   region  → every store in the employee's regionId (via its clusters)
   */
  async resolveForUser(userId: string, roles: string[]): Promise<StoreScope> {
    if ((roles ?? []).some(role => GLOBAL_ROLES.has(role))) return GLOBAL_SCOPE;

    const employee = await this.employeeRepo.findOne({
      where: {userId, isDeleted: false},
      fields: {id: true, storeId: true, clusterId: true, regionId: true},
    });
    if (!employee) return EMPTY_SCOPE;

    const scope = await this.resolveRoleScope(roles);

    if (scope === 'region') {
      if (!employee.regionId) return EMPTY_SCOPE;
      return {global: false, storeIds: await this.storeIdsForRegion(String(employee.regionId))};
    }
    if (scope === 'cluster') {
      if (!employee.clusterId) return EMPTY_SCOPE;
      return {global: false, storeIds: await this.storeIdsForCluster(String(employee.clusterId))};
    }
    // store scope (default)
    if (!employee.storeId) return EMPTY_SCOPE;
    return {global: false, storeIds: [String(employee.storeId)]};
  }

  /** The scope level of the caller's primary role; defaults to the narrowest. */
  private async resolveRoleScope(roles: string[]): Promise<RoleScope> {
    const roleValue = (roles ?? [])[0];
    if (!roleValue) return 'store';
    const role = await this.rolesRepo.findOne({
      where: {value: roleValue},
      fields: {id: true, scope: true},
    });
    const scope = role?.scope;
    return scope === 'cluster' || scope === 'region' ? scope : 'store';
  }

  private async storeIdsForCluster(clusterId: string): Promise<string[]> {
    const stores = await this.storeRepo.find({
      where: {clusterId, isDeleted: false},
      fields: {id: true},
    });
    return stores.map(store => String(store.id)).filter(Boolean);
  }

  private async storeIdsForRegion(regionId: string): Promise<string[]> {
    const clusters = await this.clusterRepo.find({
      where: {regionId, isDeleted: false},
      fields: {id: true},
    });
    const clusterIds = clusters.map(cluster => String(cluster.id)).filter(Boolean);
    if (!clusterIds.length) return [];
    const stores = await this.storeRepo.find({
      where: {clusterId: {inq: clusterIds}, isDeleted: false} as object,
      fields: {id: true},
    });
    return stores.map(store => String(store.id)).filter(Boolean);
  }

  /**
   * Resolve the caller's scope for the current request. Prefers the JWT snapshot;
   * falls back to a database lookup for tokens minted before store scope existed,
   * so existing sessions are not silently emptied out.
   */
  async resolve(currentUser: UserProfile): Promise<StoreScope> {
    const roles: string[] = (currentUser?.roles as string[]) ?? [];
    if (roles.some(role => GLOBAL_ROLES.has(role))) return GLOBAL_SCOPE;

    const claim = (currentUser as {storeScope?: unknown})?.storeScope;
    if (claim === STORE_SCOPE_GLOBAL) return GLOBAL_SCOPE;
    if (Array.isArray(claim)) {
      return {global: false, storeIds: claim.map(String).filter(Boolean)};
    }

    // Legacy token with no storeScope claim — resolve from the database.
    const userId = String(currentUser?.id ?? '');
    if (!userId) return EMPTY_SCOPE;
    return this.resolveForUser(userId, roles);
  }

  /** Build the JWT claim value for a resolved scope. */
  toClaim(scope: StoreScope): string | string[] {
    return scope.global ? STORE_SCOPE_GLOBAL : scope.storeIds;
  }

  /**
   * Guard for everything that hangs off an order — invoices, challans, credit
   * notes, intake rejections, approvals, garments. Most of those models carry no
   * storeId of their own and reach a store only through their order.
   *
   * Reports an out-of-scope order as 404 rather than 403 (D4): a 403 would confirm
   * the order exists in another store.
   */
  async assertOrderVisible(orderId: string, currentUser: UserProfile): Promise<void> {
    const scope = await this.resolve(currentUser);
    if (scope.global) return;

    const order = await this.orderRepo.findOne({
      where: {id: orderId, isDeleted: false},
      fields: {id: true, storeId: true},
    });
    if (!order || !this.allows(scope, order.storeId)) {
      throw new HttpErrors.NotFound('Order not found.');
    }
  }

  /** True when the caller may act on / see the given store. */
  allows(scope: StoreScope, storeId?: string | null): boolean {
    if (scope.global) return true;
    if (!storeId) return false;
    return scope.storeIds.includes(String(storeId));
  }

  /**
   * A `where` fragment restricting a store-bearing model to the caller's scope,
   * or `null` when the caller is global and no filtering is needed.
   */
  storeFilter(scope: StoreScope): {storeId: {inq: string[]}} | null {
    if (scope.global) return null;
    return {storeId: {inq: scope.storeIds}};
  }
}
