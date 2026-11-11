import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';

const store = (id: string, name: string, pincode = '999999') => ({
  id,
  name,
  code: id.toUpperCase(),
  address: `${name} Road`,
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode,
  latitude: '19.0',
  longitude: '72.8',
});

describe('StoreAssignmentService.listStoresForPincode', () => {
  it('lists only measured covering stores inside the configured radius', async () => {
    let storeWhere: object | undefined;
    const service = new StoreAssignmentService(
      {
        find: async (filter: {where: object}) => {
          storeWhere = filter.where;
          return [store('far', 'Far'), store('near', 'Near')];
        },
      } as never,
      {
        find: async () => [
          {storeId: 'far', centroidDistanceKm: '8.5', pctOfPincodeInRange: '40'},
          {storeId: 'near', centroidDistanceKm: '2', pctOfPincodeInRange: '100'},
          {storeId: 'near', centroidDistanceKm: '3'},
          {storeId: 'outside', centroidDistanceKm: '15.1', pctOfPincodeInRange: '100'},
          {storeId: 'unknown-null', centroidDistanceKm: null},
          {storeId: 'unknown-empty', centroidDistanceKm: ''},
        ],
      } as never,
    );

    const stores = await service.listStoresForPincode(' 400001 ');

    expect(stores.map(s => s.id)).to.deepEqual(['near', 'far']);
    expect(stores[0]).to.containDeep({
      storeId: 'near',
      storeName: 'Near',
      centroidDistanceKm: 2,
      pctOfPincodeInRange: 100,
      matchedBy: 'coverage',
      latitude: 19,
    });
    expect(storeWhere).to.deepEqual({
      isActive: true,
      isDeleted: false,
      id: {inq: ['far', 'near']},
    });
  });

  it('does not return unmeasured stores when there are no coverage rows', async () => {
    let storeQueries = 0;
    const service = new StoreAssignmentService(
      {find: async () => { storeQueries++; return [store('in-pin', 'Local', '400001')]; }} as never,
      {find: async () => []} as never,
    );
    expect(await service.listStoresForPincode('400001')).to.deepEqual([]);
    expect(storeQueries).to.equal(0);
  });

  it('returns nothing for an invalid pincode without querying', async () => {
    const service = new StoreAssignmentService({} as never, {} as never);
    expect(await service.listStoresForPincode('40001')).to.deepEqual([]);
  });
});
