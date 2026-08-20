import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {UserProfile} from '@loopback/security';
import {
  ClusterRepository,
  EmployeeRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
  RolesRepository,
  StoreRepository,
  TransferRepository,
} from '../repositories';

/** Scope levels a role can declare (Roles.scope). super_admin ignores these. */
type RoleScope = 'store' | 'cluster' | 'region';

/**
 * Resolved store access for a caller.
 * `global` means every store (no filtering); otherwise only `storeIds` are visible.
 * `scopeLevel` names which binding was authoritative — callers that need a
 * single "this employee's store" id (e.g. defaulting the New Order screen)
 * must check this is 'store' first: a cluster/region-scoped employee can
 * carry a stale storeId from before their role was re-scoped, and treating
 * it as still authoritative would wrongly pin them to that one old store.
 */
export type StoreScope = {
  global: boolean;
  storeIds: string[];
  scopeLevel: RoleScope | 'global';
};

/** Sentinel stored in the JWT for callers that may see every store. */
export const STORE_SCOPE_GLOBAL = '*';

/** Roles that are never store-bound (bypass all scope). */
const GLOBAL_ROLES = new Set(['super_admin']);

const GLOBAL_SCOPE: StoreScope = {global: true, storeIds: [], scopeLevel: 'global'};
/** Fail closed: a bound caller we cannot resolve sees nothing. */
const EMPTY_SCOPE = (scopeLevel: RoleScope): StoreScope => ({global: false, storeIds: [], scopeLevel});

@injectable({scope: BindingScope.TRANSIENT})
export class StoreScopeService {
  constructor(
    @repository(EmployeeRepository) private employeeRepo: EmployeeRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(RolesRepository) private rolesRepo: RolesRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(TransferRepository) private transferRepo: TransferRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
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

    const scope = await this.resolveRoleScope(roles);

    const employee = await this.employeeRepo.findOne({
      where: {userId, isDeleted: false},
      fields: {id: true, storeId: true, clusterId: true, regionId: true},
    });
    if (!employee) return EMPTY_SCOPE(scope);

    if (scope === 'region') {
      if (!employee.regionId) return EMPTY_SCOPE(scope);
      return {global: false, storeIds: await this.storeIdsForRegion(String(employee.regionId)), scopeLevel: scope};
    }
    if (scope === 'cluster') {
      if (!employee.clusterId) return EMPTY_SCOPE(scope);
      return {global: false, storeIds: await this.storeIdsForCluster(String(employee.clusterId)), scopeLevel: scope};
    }
    // store scope (default)
    if (!employee.storeId) return EMPTY_SCOPE(scope);
    return {global: false, storeIds: [String(employee.storeId)], scopeLevel: scope};
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
      // The JWT claim is just the resolved store id list — it doesn't carry
      // which binding produced it. Nothing on this per-request hot path reads
      // scopeLevel (only the login flow does, straight off resolveForUser),
      // so this placeholder is never actually consulted.
      return {global: false, storeIds: claim.map(String).filter(Boolean), scopeLevel: 'store'};
    }

    // Legacy token with no storeScope claim — resolve from the database.
    const userId = String(currentUser?.id ?? '');
    if (!userId) return EMPTY_SCOPE('store');
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
   *
   * Also visible to a store that doesn't own the order but currently holds
   * one of its garments via an active inter-store transfer (see
   * isOrderGrantedViaTransfer) — additive, the home store never loses
   * access.
   */
  async assertOrderVisible(orderId: string, currentUser: UserProfile): Promise<void> {
    const scope = await this.resolve(currentUser);
    if (scope.global) return;

    const order = await this.orderRepo.findOne({
      where: {id: orderId, isDeleted: false},
      fields: {id: true, storeId: true},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (this.allows(scope, order.storeId)) return;
    if (await this.isOrderGrantedViaTransfer(orderId, scope)) return;
    throw new HttpErrors.NotFound('Order not found.');
  }

  /**
   * True if this order has a garment currently granted to the caller's
   * scope via an active inter-store transfer (Garment.activeTransferId ->
   * Transfer.toStoreId). Targeted to one order — safe to call on every
   * order-detail/action request, unlike transferGrantedOrderIds below
   * which scans system-wide and is meant for list/filter call sites.
   */
  async isOrderGrantedViaTransfer(orderId: string, scope: StoreScope): Promise<boolean> {
    if (scope.global) return true;

    const orderItems = await this.orderItemRepo.find({
      where: {orderId} as object,
      fields: {id: true} as object,
    });
    if (!orderItems.length) return false;

    const garments = await this.garmentRepo.find({
      where: {
        orderItemId: {inq: orderItems.map(oi => oi.id)},
        activeTransferId: {neq: null as unknown as string},
        isDeleted: false,
      } as object,
      fields: {activeTransferId: true} as object,
    });
    if (!garments.length) return false;

    const transferIds = [...new Set(garments.map(g => g.activeTransferId).filter(Boolean))] as string[];
    const grantingTransfer = await this.transferRepo.findOne({
      where: {id: {inq: transferIds}, toStoreId: {inq: scope.storeIds}} as object,
      fields: {id: true} as object,
    });
    return Boolean(grantingTransfer);
  }

  /**
   * Every order id currently granted to the caller's scope via an active
   * inter-store transfer — batch version for list/filter call sites
   * (listOrders, garment/approval store-scope filters, sales-return's
   * inline filter). Starts from Transfer (few transfers en route to any
   * one store at a time) rather than scanning every granted garment
   * system-wide.
   *
   * Takes a plain store id list rather than a StoreScope so it also works
   * for a global caller who's manually narrowed to one store (e.g. an
   * admin filtering the order list to a specific store) — that case still
   * has a real, non-empty storeIds list even though scope.global is true.
   */
  async transferGrantedOrderIds(storeIds: string[]): Promise<string[]> {
    if (!storeIds.length) return [];

    const transfers = await this.transferRepo.find({
      where: {toStoreId: {inq: storeIds}} as object,
      fields: {id: true} as object,
    });
    if (!transfers.length) return [];

    const garments = await this.garmentRepo.find({
      where: {
        activeTransferId: {inq: transfers.map(t => t.id)},
        isDeleted: false,
      } as object,
      fields: {orderItemId: true} as object,
    });
    if (!garments.length) return [];

    const orderItems = await this.orderItemRepo.find({
      where: {id: {inq: [...new Set(garments.map(g => g.orderItemId))]}} as object,
      fields: {orderId: true} as object,
    });
    return [...new Set(orderItems.map(oi => oi.orderId))];
  }

  /**
   * Write guard for garment-actions.controller.ts — visibility (above) is
   * additive/dual, but editing a garment stays exclusive to whichever
   * store currently holds it. Once activeTransferId is set, only the
   * transfer's toStoreId may act on it; the home store gets a clear
   * rejection instead of silently succeeding on a garment that isn't
   * physically in front of them. Unaffected when activeTransferId is
   * unset — this pass does not add any new restriction to that case.
   */
  async assertGarmentEditable(garmentId: string, currentUser: UserProfile): Promise<void> {
    const scope = await this.resolve(currentUser);
    if (scope.global) return;

    const garment = await this.garmentRepo.findOne({
      where: {id: garmentId, isDeleted: false} as object,
      fields: {id: true, activeTransferId: true} as object,
    });
    if (!garment) throw new HttpErrors.NotFound('Garment not found.');
    if (!garment.activeTransferId) return;

    const transfer = await this.transferRepo.findOne({
      where: {id: garment.activeTransferId} as object,
      fields: {id: true, toStoreId: true} as object,
    });
    if (transfer && this.allows(scope, transfer.toStoreId)) return;

    throw new HttpErrors.BadRequest('This garment is currently at a different store and cannot be edited here.');
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

  /**
   * Narrow an already-resolved scope down to a UI-selected store or cluster —
   * for a cluster/region-scoped caller filtering their own store list down to
   * one store, or a region-scoped caller filtering down to one cluster. This
   * can only ever SHRINK what a caller sees, never grow it: the candidate ids
   * (from the query param) are intersected against `scope.storeIds`, so a
   * `storeId`/`clusterId` naming something outside the caller's own scope
   * resolves to an empty list (sees nothing) rather than leaking into another
   * store/cluster/region. A global (super_admin) caller has no scope to
   * intersect against, so the candidate ids are returned as-is.
   *
   * Returns `null` (no filtering) only when the caller is global AND no
   * store/cluster filter was requested.
   */
  async narrowStoreIds(
    scope: StoreScope,
    filters: {storeId?: string; clusterId?: string},
  ): Promise<string[] | null> {
    if (!filters.storeId && !filters.clusterId) {
      return scope.global ? null : scope.storeIds;
    }

    const candidateIds = filters.storeId
      ? [filters.storeId]
      : await this.storeIdsForCluster(filters.clusterId!);

    if (scope.global) return candidateIds;
    return candidateIds.filter(id => scope.storeIds.includes(id));
  }
}
