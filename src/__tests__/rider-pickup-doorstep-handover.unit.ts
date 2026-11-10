import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {RiderPickupController} from '../controllers/rider-pickup.controller';
import {PickupHandoverBy} from '../models';
import {BagStatus} from '../models/bag-status.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';

function makeController() {
  const updates: Record<string, unknown>[] = [];
  const controller = Object.assign(Object.create(RiderPickupController.prototype), {
    riderRepository: {findOne: async () => ({id: 'rider-1', isActive: true})},
    pickupRequestRepository: {
      findOne: async () => ({
        id: 'p1',
        assignedRiderId: 'rider-1',
        status: PickupRequestStatus.ARRIVED_AT_PICKUP,
        handoverBy: PickupHandoverBy.SELF,
      }),
      updateById: async (_id: string, data: Record<string, unknown>) => updates.push(data),
    },
    bagRepository: {
      findOne: async () => ({id: 'bag-1', bagNumber: 7, isActive: true, status: BagStatus.AVAILABLE}),
      updateById: async () => {},
    },
    serviceRepository: {find: async () => [{id: 'service-1', name: 'Wash'}]},
    dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
    pickupRequestService: {notifyPickedUp: () => {}},
  }) as RiderPickupController;
  return {controller, updates};
}

const user = {[securityId]: 'user-1'} as UserProfile;
const pickedUp = {
  status: PickupRequestStatus.PICKED_UP,
  itemsByService: [{serviceId: 'service-1', quantity: 3, bagId: 'bag-1'}],
};

describe('rider doorstep handover on picked_up', () => {
  it('records who actually handed the clothes over', async () => {
    const {controller, updates} = makeController();
    await controller.updateStatus(user, 'p1', {
      ...pickedUp,
      handoverBy: PickupHandoverBy.FAMILY_MEMBER,
      handoverPersonName: '  Suresh ',
    });
    expect(updates[0]).to.containDeep({handoverBy: PickupHandoverBy.FAMILY_MEMBER, handoverPersonName: 'Suresh'});
  });

  it('keeps the booking value when the rider app does not send one', async () => {
    const {controller, updates} = makeController();
    await controller.updateStatus(user, 'p1', pickedUp);
    expect(updates[0]).to.not.have.property('handoverBy');
    expect(updates[0]).to.not.have.property('handoverPersonName');
  });

  it('requires a name unless the customer handed it over themselves', async () => {
    const {controller} = makeController();
    await expect(
      controller.updateStatus(user, 'p1', {...pickedUp, handoverBy: PickupHandoverBy.HOUSEHOLD_HELP}),
    ).to.be.rejectedWith('handoverPersonName is required unless handoverBy is "self".');
  });
});
