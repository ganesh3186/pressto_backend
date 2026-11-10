import {expect} from '@loopback/testlab';
import {PincodeStore, StoreAssignmentService} from '../services/store-assignment.service';

const pincodeStore = (id: string, latitude: number | null, longitude: number | null): PincodeStore => ({
  id,
  name: id,
  code: id.toUpperCase(),
  address: '',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
  phone: null,
  latitude,
  longitude,
  centroidDistanceKm: null,
  pctOfPincodeInRange: null,
  matchedBy: 'coverage',
});

describe('StoreAssignmentService.resolveStoreWithinPincode', () => {
  // Any store-table read here would mean it fell back to the
  // coordinate-first lookup, which can pick a store outside the list.
  const service = new StoreAssignmentService(
    {find: async () => [{id: 'outside', name: 'Outside', code: 'OUT', latitude: 19.0, longitude: 72.8}]} as never,
    {find: async () => []} as never,
  );

  it('picks the pincode store nearest the coordinates, never one outside the list', async () => {
    const result = await service.resolveStoreWithinPincode(
      {latitude: 19.0, longitude: 72.8, pincode: '400001'},
      [pincodeStore('far', 19.2, 72.9), pincodeStore('near', 19.01, 72.81), pincodeStore('no-coords', null, null)],
    );
    expect(result.store?.id).to.equal('near');
    expect(result.matchedBy).to.equal('pincode');
    expect(result.store?.distanceKm).to.be.a.Number();
  });

  it('uses the first pincode store when there are no coordinates', async () => {
    const result = await service.resolveStoreWithinPincode({pincode: '400001'}, [
      pincodeStore('first', 19.2, 72.9),
      pincodeStore('second', 19.01, 72.81),
    ]);
    expect(result.store?.id).to.equal('first');
  });

  it('falls back to the nearest store by coordinates when no store serves the pincode', async () => {
    const result = await service.resolveStoreWithinPincode({latitude: 19.0, longitude: 72.8, pincode: '400001'}, []);
    expect(result.store?.id).to.equal('outside');
    expect(result.matchedBy).to.equal('coordinates');
  });
});
