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
  it('lists covering stores nearest first, then stores located in the pincode', async () => {
    let storeWhere: object | undefined;
    const service = new StoreAssignmentService(
      {
        find: async (filter: {where: object}) => {
          storeWhere = filter.where;
          return [store('in-pin', 'Local', '400001'), store('far', 'Far'), store('near', 'Near')];
        },
      } as never,
      {
        find: async () => [
          {storeId: 'far', centroidDistanceKm: '8.5', pctOfPincodeInRange: '40'},
          {storeId: 'near', centroidDistanceKm: '2', pctOfPincodeInRange: '100'},
          {storeId: 'near', centroidDistanceKm: '3'},
        ],
      } as never,
    );

    const stores = await service.listStoresForPincode(' 400001 ');

    expect(stores.map(s => s.id)).to.deepEqual(['near', 'far', 'in-pin']);
    expect(stores[0]).to.containDeep({centroidDistanceKm: 2, pctOfPincodeInRange: 100, matchedBy: 'coverage', latitude: 19});
    expect(stores[2]).to.containDeep({centroidDistanceKm: null, matchedBy: 'store_pincode'});
    expect(storeWhere).to.deepEqual({
      isActive: true,
      isDeleted: false,
      or: [{pincode: '400001'}, {id: {inq: ['far', 'near']}}],
    });
  });

  it('still finds stores located in a pincode with no coverage rows', async () => {
    const service = new StoreAssignmentService(
      {find: async () => [store('in-pin', 'Local', '400001')]} as never,
      {find: async () => []} as never,
    );
    expect((await service.listStoresForPincode('400001')).map(s => s.id)).to.deepEqual(['in-pin']);
  });

  it('returns nothing for an invalid pincode without querying', async () => {
    const service = new StoreAssignmentService({} as never, {} as never);
    expect(await service.listStoresForPincode('40001')).to.deepEqual([]);
  });
});
