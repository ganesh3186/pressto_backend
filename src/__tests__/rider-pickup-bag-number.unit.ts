import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {RiderPickupController} from '../controllers/rider-pickup.controller';

describe('rider pickup bag numbers', () => {
  it('replaces primary and per-service bag IDs in the pickup list', async () => {
    let queriedBagIds: string[] = [];
    const controller = Object.assign(Object.create(RiderPickupController.prototype), {
      resolveActiveRider: async () => ({id: 'rider-1'}),
      pickupRequestRepository: {find: async () => [
        {
          id: 'pickup-1', bagId: 'bag-1', pickupSlot: {startTime: '09:00', endTime: '12:00'},
          actualItemsByService: [
            {serviceId: 'service-1', bagId: 'bag-1'},
            {serviceId: 'service-2', bagId: 'bag-2'},
          ],
        },
        {id: 'pickup-2'},
      ]},
      bagRepository: {find: async ({where}: {where: {id: {inq: string[]}}}) => {
        queriedBagIds = where.id.inq;
        return [{id: 'bag-1', bagNumber: 101}, {id: 'bag-2', bagNumber: 102}];
      }},
    }) as RiderPickupController;

    const pickups = await controller.myPickupRequests({} as UserProfile) as Array<{
      bagId?: string;
      bagNumber: number | null;
      pickupSlot?: {startTime: string};
      actualItemsByService?: Array<{bagId?: string; bagNumber: number}>;
    }>;

    expect(queriedBagIds).to.deepEqual(['bag-1', 'bag-2']);
    expect(pickups[0].bagNumber).to.equal(101);
    expect(pickups[0].bagId).to.equal(undefined);
    expect(pickups[0].pickupSlot?.startTime).to.equal('09:00');
    expect(pickups[0].actualItemsByService?.map(line => line.bagNumber)).to.deepEqual([101, 102]);
    expect(pickups[0].actualItemsByService?.map(line => line.bagId)).to.deepEqual([undefined, undefined]);
    expect(pickups[1].bagNumber).to.equal(null);
  });
});
