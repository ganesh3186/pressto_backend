import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';
import {storeSearchRadiusKm} from '../utils/config';

describe('STORE_SEARCH_RADIUS_KM', () => {
  it('defaults to 15 and accepts any finite positive number', () => {
    expect(storeSearchRadiusKm({})).to.equal(15);
    expect(storeSearchRadiusKm({STORE_SEARCH_RADIUS_KM: ''})).to.equal(15);
    expect(storeSearchRadiusKm({STORE_SEARCH_RADIUS_KM: ' 10 '})).to.equal(10);
    expect(storeSearchRadiusKm({STORE_SEARCH_RADIUS_KM: '7.5'})).to.equal(7.5);
  });

  it('rejects a configured value that is not a finite positive number', () => {
    for (const bad of ['0', '-5', 'abc', 'Infinity', 'NaN', '10km']) {
      expect(() => storeSearchRadiusKm({STORE_SEARCH_RADIUS_KM: bad})).to.throw(/STORE_SEARCH_RADIUS_KM/);
    }
  });

  it('still reads the old STORE_ASSIGNMENT_RADIUS_KM name, with the new name taking priority', () => {
    expect(storeSearchRadiusKm({STORE_ASSIGNMENT_RADIUS_KM: '12'})).to.equal(12);
    expect(storeSearchRadiusKm({STORE_ASSIGNMENT_RADIUS_KM: '12', STORE_SEARCH_RADIUS_KM: '10'})).to.equal(10);
  });
});

describe('shared radius applies to every store eligibility flow', () => {
  const ORIGIN = {latitude: 19.0, longitude: 72.8};
  const kmNorth = (km: number) => ORIGIN.latitude + (km / 6371) * (180 / Math.PI);
  const store12 = {
    id: 's12',
    name: 'Twelve',
    code: 'S12',
    address: 'Road',
    city: 'Mumbai',
    state: 'MH',
    pincode: '400001',
    latitude: kmNorth(12),
    longitude: ORIGIN.longitude,
  };
  const saved = {
    search: process.env.STORE_SEARCH_RADIUS_KM,
    legacy: process.env.STORE_ASSIGNMENT_RADIUS_KM,
  };
  afterEach(() => {
    for (const [key, value] of [
      ['STORE_SEARCH_RADIUS_KM', saved.search],
      ['STORE_ASSIGNMENT_RADIUS_KM', saved.legacy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const service = () =>
    new StoreAssignmentService(
      {find: async () => [store12]} as never,
      {find: async () => [{storeId: 's12', centroidDistanceKm: '12', pctOfPincodeInRange: '80'}]} as never,
    );

  async function flows() {
    const s = service();
    return {
      coordinates: (await s.resolveForCoordinates(ORIGIN.latitude, ORIGIN.longitude)).nearestWithinRadius?.id ?? null,
      nearest: (await s.resolveNearestStore(ORIGIN)).store?.id ?? null,
      pincodeList: (await s.listStoresForPincode('400001')).map(x => x.id),
      pincodeCoverage: (await s.resolveForPincode('400001'))?.id ?? null,
    };
  }

  it('includes the 12 km store at the default 15 km', async () => {
    delete process.env.STORE_SEARCH_RADIUS_KM;
    delete process.env.STORE_ASSIGNMENT_RADIUS_KM;
    expect(StoreAssignmentService.radiusKm()).to.equal(15);
    expect(await flows()).to.deepEqual({
      coordinates: 's12',
      nearest: 's12',
      pincodeList: ['s12'],
      pincodeCoverage: 's12',
    });
  });

  it('drops the 12 km store from every flow at 10 km', async () => {
    process.env.STORE_SEARCH_RADIUS_KM = '10';
    expect(StoreAssignmentService.radiusKm()).to.equal(10);
    expect(await flows()).to.deepEqual({
      coordinates: null,
      nearest: null,
      pincodeList: [],
      pincodeCoverage: null,
    });
  });
});
