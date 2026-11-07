import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';

describe('store assignment by pincode', () => {
  it('selects the nearest active store covering the pincode', async () => {
    const service = new StoreAssignmentService(
      {
        find: async () => [{id: 'store-near'}, {id: 'store-far'}],
      } as never,
      {
        find: async () => [
          {storeId: 'store-near', centroidDistanceKm: 2},
          {storeId: 'store-far', centroidDistanceKm: 8},
        ],
      } as never,
    );

    expect((await service.resolveForPincode('400001'))?.id).to.equal('store-near');
  });

  it('does not query coverage for an invalid pincode', async () => {
    const service = new StoreAssignmentService({} as never, {} as never);
    expect(await service.resolveForPincode('invalid')).to.equal(null);
  });
});
