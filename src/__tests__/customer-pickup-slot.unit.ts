import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {CustomerProfileController} from '../controllers/customer-profile.controller';
import {PickupRequest} from '../models';

describe('customer pickup slot', () => {
  it('includes the booked slot in list and detail without widening customer scope', async () => {
    const pickup = {
      id: 'pickup-1',
      customerId: 'customer-1',
      slot: 'Morning',
      pickupSlotId: 'slot-1',
      pickupSlot: {id: 'slot-1', label: 'Morning', startTime: '09:00', endTime: '12:00'},
    } as unknown as PickupRequest;
    const filters: object[] = [];
    const controller = Object.assign(Object.create(CustomerProfileController.prototype), {
      resolveCustomer: async () => ({id: 'customer-1'}),
      pickupRequestRepository: {
        find: async (filter: object) => {
          filters.push(filter);
          return [pickup];
        },
        findOne: async (filter: object) => {
          filters.push(filter);
          return pickup;
        },
      },
    }) as CustomerProfileController;
    const user = {[securityId]: 'user-1'} as UserProfile;

    const list = await controller.getPickupRequests(user);
    const detail = await controller.getPickupRequestById(user, 'pickup-1');

    expect(filters).to.deepEqual([
      {
        where: {customerId: 'customer-1', isDeleted: false},
        include: [{relation: 'pickupSlot'}],
        order: ['createdAt DESC'],
      },
      {where: {id: 'pickup-1', isDeleted: false}, include: [{relation: 'pickupSlot'}]},
    ]);
    expect(list[0]).to.equal(pickup);
    expect(detail).to.equal(pickup);
  });
});
