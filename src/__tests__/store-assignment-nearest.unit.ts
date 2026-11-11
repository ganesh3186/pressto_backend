import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';

// Store A sits at the test point; Store B is ~110 km north (1 degree lat).
const STORES = [
  {id: 'store-a', name: 'A', code: 'A', latitude: 19.0, longitude: 72.8},
  {id: 'store-b', name: 'B', code: 'B', latitude: 20.0, longitude: 72.8},
];

function makeService(coverage: object[] = []) {
  return new StoreAssignmentService(
    {
      // sortedByDistance passes no `inq` filter; resolveForPincode does.
      find: async (filter: {where?: {id?: {inq?: string[]}}}) => {
        const ids = filter?.where?.id?.inq;
        return ids ? STORES.filter(s => ids.includes(s.id)) : STORES;
      },
    } as never,
    {find: async () => coverage} as never,
  );
}

describe('StoreAssignmentService.resolveNearestStore', () => {
  it('resolves by coordinates first', async () => {
    const result = await makeService().resolveNearestStore({latitude: 19.01, longitude: 72.8, pincode: '400001'});
    expect(result.matchedBy).to.equal('coordinates');
    expect(result.store?.id).to.equal('store-a');
  });

  it('falls back to pincode when no coordinates are given', async () => {
    const result = await makeService([{storeId: 'store-b', centroidDistanceKm: 1}]).resolveNearestStore({
      pincode: '400001',
    });
    expect(result.matchedBy).to.equal('pincode');
    expect(result.store?.id).to.equal('store-b');
  });

  it('does not bypass the radius with pincode coverage when coordinates are available', async () => {
    const result = await makeService([{storeId: 'store-a', centroidDistanceKm: 1}]).resolveNearestStore({
      latitude: 25.0,
      longitude: 72.8,
      pincode: '400001',
    });
    expect(result.matchedBy).to.equal(null);
    expect(result.store).to.equal(null);
    expect(result.nearbyBeyondRadius.length).to.be.greaterThan(0);
  });

  it('treats out-of-range coordinates as missing and falls back to pincode', async () => {
    const result = await makeService([{storeId: 'store-b', centroidDistanceKm: 1}]).resolveNearestStore({
      latitude: 200,
      longitude: 72.8,
      pincode: '400001',
    });
    expect(result.matchedBy).to.equal('pincode');
    expect(result.store?.id).to.equal('store-b');
  });

  it('treats (0,0) as missing and returns nearby stores when nothing matches', async () => {
    const zero = await makeService().resolveNearestStore({latitude: 0, longitude: 0});
    expect(zero.store).to.equal(null);

    const far = await makeService().resolveNearestStore({latitude: 25.0, longitude: 72.8});
    expect(far.store).to.equal(null);
    expect(far.matchedBy).to.equal(null);
    expect(far.nearbyBeyondRadius.map(s => s.id)).to.deepEqual(['store-b', 'store-a']);
  });
});
