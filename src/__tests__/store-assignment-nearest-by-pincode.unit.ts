import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';

type Coverage = {storeId: string; pincode: string; centroidDistanceKm?: number};
type Located = {id: string; pincode: string};

function makeService(coverage: Coverage[], located: Located[], inactive: string[] = []) {
  const names: Record<string, string> = {};
  for (const id of [...coverage.map(c => c.storeId), ...located.map(s => s.id)]) names[id] = id.toUpperCase();
  return new StoreAssignmentService(
    {
      find: async (filter: {where: {id?: {inq: string[]}}}) => {
        // The final active-store lookup filters by id; the candidate lookup by pincode.
        if (filter.where.id) {
          return filter.where.id.inq
            .filter(id => !inactive.includes(id))
            .map(id => ({id, name: names[id], code: id}));
        }
        return located;
      },
    } as never,
    {find: async () => coverage} as never,
  );
}

describe('StoreAssignmentService.nearestStoreByPincode', () => {
  it('prefers an exact pincode match, then the closest coverage distance', async () => {
    const service = makeService(
      [
        {storeId: 'far', pincode: '400013', centroidDistanceKm: 6},
        {storeId: 'near', pincode: '400013', centroidDistanceKm: 2},
        {storeId: 'other-district', pincode: '400101', centroidDistanceKm: 0.5},
      ],
      [],
    );
    expect((await service.nearestStoreByPincode('400013'))?.id).to.equal('near');
  });

  it('falls back to the numerically closest pincode in the same 3-digit district', async () => {
    // 400101 has no store of its own; 400104 is closer than 400001.
    const service = makeService(
      [{storeId: 'south', pincode: '400001'}],
      [{id: 'north', pincode: '400104'}],
    );
    expect((await service.nearestStoreByPincode('400101'))?.id).to.equal('north');
  });

  it('does not guess across districts', async () => {
    // 401107 (Mira Road) shares only "40" with these — distance unknown.
    const service = makeService([{storeId: 'vashi', pincode: '400710'}], [{id: 'kandivali', pincode: '400067'}]);
    expect(await service.nearestStoreByPincode('401107')).to.equal(null);
  });

  it('skips an inactive best match', async () => {
    const service = makeService(
      [{storeId: 'closed', pincode: '400013'}, {storeId: 'open', pincode: '400012'}],
      [],
      ['closed'],
    );
    expect((await service.nearestStoreByPincode('400013'))?.id).to.equal('open');
  });

  it('returns null with no store in the district, or for an invalid pincode', async () => {
    expect(await makeService([], []).nearestStoreByPincode('560001')).to.equal(null);
    expect(await makeService([], []).nearestStoreByPincode('4001')).to.equal(null);
  });
});
