import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {PickupRequestController, pickupScopeWhere} from '../controllers/pickup-request.controller';
import {PickupRequest} from '../models';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';

const NOT_SERVICEABLE = PickupRequestStatus.NOT_SERVICEABLE;

function makeController(storeIds: string[], pickup?: Partial<PickupRequest>) {
  const calls: {where?: object} = {};
  const controller = Object.assign(Object.create(PickupRequestController.prototype), {
    storeScopeService: {
      resolve: async () => ({global: false, storeIds}),
      narrowStoreIds: async () => storeIds,
    },
    pickupRequestRepository: {
      find: async (filter: {where: object}) => {
        calls.where = filter.where;
        return [];
      },
      findOne: async () => pickup,
    },
    enrichWithSuggestedRider: async (rows: unknown[]) => rows,
    enrichWithReworkOrderNumber: async (rows: unknown[]) => rows,
  }) as PickupRequestController;
  return {controller, calls};
}

describe('not-serviceable pickup store scope', () => {
  it('shows a not-serviceable pickup only to its nearest store in the default list', () => {
    expect(pickupScopeWhere(['store-a'], true)).to.deepEqual({
      or: [
        {storeId: {inq: ['store-a']}},
        {storeId: null, nearestStoreId: {inq: ['store-a']}},
        // open unassigned intake only — never not-serviceable or cancelled
        {storeId: null, nearestStoreId: null, status: {nin: [NOT_SERVICEABLE, PickupRequestStatus.CANCELLED]}},
      ],
    });
  });

  it('keeps a cancelled not-serviceable pickup away from every store', async () => {
    // Customer cancelled PU000012: status cancelled, still no store or nearest store.
    const pickup = {id: 'p1', status: PickupRequestStatus.CANCELLED, storeId: undefined, nearestStoreId: undefined};
    const {controller} = makeController(['store-a'], pickup);
    await expect(controller.deleteById({} as UserProfile, 'p1')).to.be.rejectedWith('Pickup request not found.');
  });

  it('hides a not-serviceable pickup with no known nearest store from every store', async () => {
    const pickup = {id: 'p1', status: NOT_SERVICEABLE, storeId: undefined, nearestStoreId: undefined};
    const {controller} = makeController(['store-a'], pickup);
    await expect(controller.deleteById({} as UserProfile, 'p1')).to.be.rejectedWith('Pickup request not found.');
  });

  it("keeps a store's not-serviceable pickups under an explicit store filter", () => {
    expect(pickupScopeWhere(['store-a'], false)).to.deepEqual({
      or: [{storeId: {inq: ['store-a']}}, {storeId: null, nearestStoreId: {inq: ['store-a']}}],
    });
  });

  it("ANDs the scope with the caller's own where instead of overwriting its `or`", async () => {
    const {controller, calls} = makeController(['store-a']);
    const callerWhere = {or: [{customerName: 'Priya'}, {customerMobile: '98765'}]};
    await controller.find({} as UserProfile, {where: callerWhere} as never);

    expect(calls.where).to.deepEqual({
      and: [callerWhere, pickupScopeWhere(['store-a'], true), {isDeleted: false}],
    });
  });

  it('hides a not-serviceable pickup by id from a store that is not its nearest', async () => {
    const pickup = {id: 'p1', status: NOT_SERVICEABLE, storeId: undefined, nearestStoreId: 'store-a'};
    const {controller} = makeController(['store-b'], pickup);
    await expect(controller.deleteById({} as UserProfile, 'p1')).to.be.rejectedWith('Pickup request not found.');
  });
});
