import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {CustomerProfileController} from '../controllers/customer-profile.controller';
import {PickupHandoverBy} from '../models';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';

/**
 * The 15 km rule for a customer booking:
 *   nearest store within the radius → serviceable, assigned to that store;
 *   otherwise → not serviceable, shown only to the closest store (any distance).
 */
function book(resolution: {
  store: {id: string; name: string; code: string} | null;
  nearbyStores: {id: string; distanceKm: number}[];
}, pincodeStoreId: string | null = null) {
  const created: Record<string, unknown>[] = [];
  const controller = Object.assign(Object.create(CustomerProfileController.prototype), {
    resolveCustomer: async () => ({id: 'customer-1', firstName: 'Priya', lastName: 'Shah'}),
    addressService: {
      findById: async () => ({id: 'address-1', customerId: 'customer-1', pincode: '401107'}),
      resolvePickupStore: async () => ({matchedBy: null, distanceKm: null, ...resolution}),
      toDisplaySnapshot: () => 'Mira Road, 401107',
    },
    pickupSlotRepository: {findOne: async () => ({id: 'slot-1', label: 'Morning'})},
    usersRepository: {findById: async () => ({phone: '9999999999', countryCode: '+91'})},
    pickupRequestRepository: {count: async () => ({count: 0})},
    pickupRequestService: {
      createRequest: async (data: Record<string, unknown>) => {
        created.push(data);
        return data;
      },
    },
    storeAssignmentService: {
      nearestStoreByPincode: async () => (pincodeStoreId ? {id: pincodeStoreId, name: 'P', code: 'P'} : null),
    },
  }) as CustomerProfileController;

  return controller
    .createPickupRequest({[securityId]: 'user-1'} as UserProfile, {
      addressId: 'address-1',
      slotId: 'slot-1',
      requestedDate: '2026-11-11',
      handoverBy: PickupHandoverBy.SELF,
      remarks: '',
      mediaIds: [],
    })
    .then(response => ({response: response as {nearbyStores?: unknown}, pickup: created[0]}));
}

describe('customer pickup serviceability (15 km rule)', () => {
  it('assigns the store within range and stays serviceable', async () => {
    const {pickup} = await book({store: {id: 'kandivali', name: 'Kandivali', code: 'ST039'}, nearbyStores: []});
    expect(pickup.storeId).to.equal('kandivali');
    expect(pickup.status).to.be.undefined(); // model default: requested
    expect(pickup.nearestStoreId).to.be.undefined();
  });

  it('marks it not serviceable and records the closest store beyond range', async () => {
    const {pickup, response} = await book({
      store: null,
      nearbyStores: [{id: 'closest-40km', distanceKm: 40}, {id: 'next-55km', distanceKm: 55}],
    });
    expect(pickup.storeId).to.be.undefined();
    expect(pickup.status).to.equal(PickupRequestStatus.NOT_SERVICEABLE);
    expect(pickup.nearestStoreId).to.equal('closest-40km');
    expect(response.nearbyStores).to.have.length(2);
  });

  it('falls back to the closest store by pincode when no distance can be worked out', async () => {
    const {pickup} = await book({store: null, nearbyStores: []}, 'same-district');
    expect(pickup.status).to.equal(PickupRequestStatus.NOT_SERVICEABLE);
    expect(pickup.nearestStoreId).to.equal('same-district');
  });
});
