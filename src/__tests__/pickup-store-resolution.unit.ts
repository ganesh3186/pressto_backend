import {expect} from '@loopback/testlab';
import {CustomerAddress} from '../models';
import {CustomerAddressService} from '../services/customer-address.service';

const NEAR = {id: 'near', name: 'Near', code: 'ST1', distanceKm: 3, latitude: 19, longitude: 72};
const FAR = {id: 'far', name: 'Far', code: 'ST2', distanceKm: 40, latitude: 20, longitude: 73};

function setup(options: {
  nearest?: typeof NEAR | null;
  beyond?: (typeof NEAR)[];
  pincodeStore?: {id: string; name: string; code: string} | null;
  geocoded?: {latitude: number; longitude: number} | null;
  preferredStoreId?: string;
  activeStores?: string[];
}) {
  const saved: object[] = [];
  const pincodesLookedUp: string[] = [];
  const service = new CustomerAddressService(
    {updateById: async (_id: string, data: object) => saved.push(data)} as never,
    {findById: async () => ({preferredStoreId: options.preferredStoreId})} as never,
    {
      findActiveStore: async (id: string) =>
        options.activeStores?.includes(id) ? {id, name: 'Preferred', code: 'ST9'} : null,
      resolveForCoordinates: async () => ({
        nearestWithinRadius: options.nearest ?? null,
        nearbyBeyondRadius: options.beyond ?? [],
      }),
      resolveForPincode: async (pincode: string) => {
        pincodesLookedUp.push(pincode);
        return options.pincodeStore ?? null;
      },
    } as never,
    {geocodeAddress: async () => options.geocoded ?? null} as never,
  );
  return {service, saved, pincodesLookedUp};
}

const address = (fields: Partial<CustomerAddress>) =>
  ({id: 'address-1', pincode: '400001', latitude: 19, longitude: 72, ...fields}) as CustomerAddress;

describe('staff pickup store suggestion', () => {
  const primary = address({isDefault: true, customerId: 'customer-1'});
  const other = address({isDefault: false, customerId: 'customer-1'});

  it('uses the preferred store for a primary address', async () => {
    const {service} = setup({nearest: NEAR, preferredStoreId: 'pref', activeStores: ['pref']});
    const result = await service.suggestPickupStoreForStaff(primary);

    expect(result.store).to.deepEqual({id: 'pref', name: 'Preferred', code: 'ST9'});
    expect(result.matchedBy).to.equal('preferred');
  });

  it('uses the nearest store for any other address, even with a preferred store', async () => {
    const {service} = setup({nearest: NEAR, preferredStoreId: 'pref', activeStores: ['pref']});
    const result = await service.suggestPickupStoreForStaff(other);

    expect(result.store?.id).to.equal('near');
    expect(result.matchedBy).to.equal('distance');
  });

  it('uses the nearest store for a primary address with no preferred store', async () => {
    const {service} = setup({nearest: NEAR});
    const result = await service.suggestPickupStoreForStaff(primary);

    expect(result.store?.id).to.equal('near');
  });

  it('skips a preferred store that is no longer active', async () => {
    const {service} = setup({nearest: NEAR, preferredStoreId: 'closed', activeStores: []});
    const result = await service.suggestPickupStoreForStaff(primary);

    expect(result.store?.id).to.equal('near');
  });

  it('reports not serviceable when a primary address has no preferred store and no match', async () => {
    const {service} = setup({beyond: [FAR]});
    const result = await service.suggestPickupStoreForStaff(primary);

    expect(result.store).to.equal(null);
    expect(result.nearbyStores).to.deepEqual([FAR]);
  });
});

describe('pickup store resolution', () => {
  it('prefers the nearest store within the radius', async () => {
    const {service, pincodesLookedUp} = setup({nearest: NEAR, pincodeStore: FAR});
    const result = await service.resolvePickupStore(address({}));

    expect(result.store).to.deepEqual({id: 'near', name: 'Near', code: 'ST1'});
    expect(result.matchedBy).to.equal('distance');
    expect(result.distanceKm).to.equal(3);
    expect(pincodesLookedUp).to.deepEqual([]);
  });

  it('falls back to pincode coverage and drops the nearby list', async () => {
    const {service} = setup({beyond: [FAR], pincodeStore: {id: 'cover', name: 'Cover', code: 'ST3'}});
    const result = await service.resolvePickupStore(address({}));

    expect(result.store?.id).to.equal('cover');
    expect(result.matchedBy).to.equal('pincode');
    expect(result.nearbyStores).to.deepEqual([]);
  });

  it('reports no store and the closest stores past the radius', async () => {
    const {service} = setup({beyond: [FAR]});
    const result = await service.resolvePickupStore(address({}));

    expect(result.store).to.equal(null);
    expect(result.matchedBy).to.equal(null);
    expect(result.nearbyStores).to.deepEqual([FAR]);
  });

  it('geocodes an address with placeholder coordinates and saves the result', async () => {
    const geocoded = {latitude: 18.9, longitude: 72.8};
    const {service, saved} = setup({nearest: NEAR, geocoded});
    const result = await service.resolvePickupStore(address({latitude: 0, longitude: 0}));

    expect(saved).to.deepEqual([geocoded]);
    expect(result.store?.id).to.equal('near');
  });

  it('still tries the pincode when an address cannot be geocoded', async () => {
    const {service, pincodesLookedUp} = setup({geocoded: null});
    const result = await service.resolvePickupStore(address({latitude: undefined, longitude: undefined}));

    expect(pincodesLookedUp).to.deepEqual(['400001']);
    expect(result.store).to.equal(null);
    expect(result.nearbyStores).to.deepEqual([]);
  });
});
