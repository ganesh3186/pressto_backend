import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {inactiveStoreIdsCache, StoreScopeService} from '../services/store-scope.service';

const ACTIVE = new Set(['store-open', 'store-open-2']);
const INACTIVE = ['store-closed'];

function service(employeeStoreId: string, extraStoreIds: string[] = []) {
  const storeRepo = {
    find: async (filter: {where: {id?: {inq: string[]}; or?: unknown}}) => {
      if (filter.where.or) return INACTIVE.map(id => ({id}));
      return (filter.where.id?.inq ?? []).filter(id => ACTIVE.has(id)).map(id => ({id}));
    },
  };
  return Object.assign(Object.create(StoreScopeService.prototype), {
    storeRepo,
    rolesRepo: {findOne: async () => ({scope: 'store'})},
    employeeRepo: {findOne: async () => ({id: 'emp-1', storeId: employeeStoreId})},
    employeeStoreRepo: {find: async () => extraStoreIds.map(storeId => ({storeId}))},
  }) as StoreScopeService;
}

describe('store scope with inactive stores', () => {
  beforeEach(() => inactiveStoreIdsCache.clear());

  it('leaves an inactive store out of the scope resolved at login', async () => {
    const scope = await service('store-open', ['store-closed']).resolveForUser('user-1', ['store_exec']);
    expect(scope.storeIds).to.deepEqual(['store-open']);
  });

  it('locks out a store employee whose only store is inactive', async () => {
    const svc = service('store-closed');
    const scope = await svc.resolveForUser('user-1', ['store_exec']);
    expect(scope.storeIds).to.deepEqual([]);
    expect(await svc.isLockedOutByInactiveStores(scope, {id: 'emp-1', storeId: 'store-closed'} as never)).to.equal(true);
  });

  it('does not lock out an employee with at least one active store', async () => {
    const svc = service('store-closed', ['store-open']);
    const scope = await svc.resolveForUser('user-1', ['store_exec']);
    expect(await svc.isLockedOutByInactiveStores(scope, {id: 'emp-1', storeId: 'store-closed'} as never)).to.equal(false);
  });

  it('does not lock out an employee with no store assigned', async () => {
    const svc = service('');
    const scope = await svc.resolveForUser('user-1', ['store_exec']);
    expect(await svc.isLockedOutByInactiveStores(scope, {id: 'emp-1'} as never)).to.equal(false);
  });

  it('drops a store switched off after login from an open session', async () => {
    const user = {roles: ['store_exec'], storeScope: ['store-open', 'store-closed']} as unknown as UserProfile;
    const scope = await service('store-open').resolve(user);
    expect(scope.storeIds).to.deepEqual(['store-open']);
  });

  it('refuses to open work at an inactive store', async () => {
    await expect(service('store-closed').resolveCallerStoreId('user-1'))
      .to.be.rejectedWith(/store is inactive/);
  });
});
