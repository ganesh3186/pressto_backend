import {expect} from '@loopback/testlab';
import {StoreAssignmentService} from '../services/store-assignment.service';

describe('store assignment by pincode', () => {
  it('selects the nearest active store covering the pincode', async () => {
    let storeIds: string[] | undefined;
    const service = new StoreAssignmentService(
      {
        find: async (filter: {where: {id: {inq: string[]}}}) => {
          storeIds = filter.where.id.inq;
          return [{id: 'store-near'}, {id: 'store-far'}];
        },
      } as never,
      {
        find: async () => [
          {storeId: 'store-near', centroidDistanceKm: 2},
          {storeId: 'store-far', centroidDistanceKm: 8},
          {storeId: 'store-outside', centroidDistanceKm: 15.1},
          {storeId: 'store-null', centroidDistanceKm: null},
          {storeId: 'store-empty', centroidDistanceKm: ''},
        ],
      } as never,
    );

    expect((await service.resolveForPincode('400001'))?.id).to.equal('store-near');
    expect(storeIds).to.deepEqual(['store-near', 'store-far']);
  });

  it('does not query stores when every coverage row is outside the radius', async () => {
    let storeQueries = 0;
    const service = new StoreAssignmentService(
      {find: async () => { storeQueries++; return []; }} as never,
      {find: async () => [{storeId: 'store-outside', centroidDistanceKm: 16}]} as never,
    );

    expect(await service.resolveForPincode('400001')).to.equal(null);
    expect(storeQueries).to.equal(0);
  });

  it('does not query coverage for an invalid pincode', async () => {
    const service = new StoreAssignmentService({} as never, {} as never);
    expect(await service.resolveForPincode('invalid')).to.equal(null);
  });
});
