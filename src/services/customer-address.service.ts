import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {Customer, CustomerAddress} from '../models';
import {CustomerAddressRepository, CustomerRepository} from '../repositories';
import {NearbyStore, StoreAssignmentService} from './store-assignment.service';
import {GeocodingService, hasRealCoordinates} from './geocoding.service';

export interface PickupStoreResolution {
  store: {id: string; name: string; code: string} | null;
  matchedBy: 'preferred' | 'distance' | 'pincode' | null;
  distanceKm: number | null;
  nearbyStores: NearbyStore[];
}

@injectable({scope: BindingScope.TRANSIENT})
export class CustomerAddressService {
  constructor(
    @repository(CustomerAddressRepository)
    private addressRepository: CustomerAddressRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @inject('services.store-assignment')
    private storeAssignmentService: StoreAssignmentService,
    @inject('services.geocoding')
    private geocodingService: GeocodingService,
  ) {}

  async create(customerId: string, data: Partial<CustomerAddress>): Promise<CustomerAddress> {
    const customer = await this.customerRepository.findById(customerId);

    if (data.isDefault) {
      await this.addressRepository.updateAll(
        {isDefault: false} as any,
        {customerId, isDefault: true},
      );
    }

    const address = await this.addressRepository.create({...data, customerId});

    // Same fallback as CustomerProfileController.createPickupRequest — an
    // address saved without the frontend's location picker has no usable
    // coordinates (missing, or the (0,0) "Null Island" placeholder — see
    // hasRealCoordinates), so geocode it here too rather than silently
    // never auto-assigning a store for this customer.
    await this.ensureCoordinates(address);

    // Self-registered customers have no admin-assigned store. The first
    // address with real coordinates gets one auto-assigned (nearest store
    // within STORE_ASSIGNMENT_RADIUS_KM) so store-scoped features have
    // somewhere to resolve to — never overrides a store an admin, or an
    // earlier address, already set.
    // Falls back to the pincode coverage table when coordinates are
    // missing or no store is within the radius.
    if (!customer.preferredStoreId) {
      const {store} = await this.storeAssignmentService.resolveNearestStore({
        latitude: address.latitude,
        longitude: address.longitude,
        pincode: address.pincode,
      });
      if (store) {
        // Conditional on preferredStoreId still being null — an admin
        // assignment landing after the read above must not be overwritten.
        await this.customerRepository.updateAll(
          {preferredStoreId: store.id} as Partial<Customer>,
          {id: customerId, preferredStoreId: null} as object,
        );
      }
    }

    return address;
  }

  /**
   * Which store serves a pickup at this address: the nearest within radius
   * when coordinates are available, otherwise pincode coverage. An address
   * with no usable coordinates is geocoded and saved first.
   */
  async resolvePickupStore(address: CustomerAddress): Promise<PickupStoreResolution> {
    await this.ensureCoordinates(address);

    let nearbyStores: NearbyStore[] = [];
    if (hasRealCoordinates(address.latitude, address.longitude)) {
      const resolved = await this.storeAssignmentService.resolveForCoordinates(
        address.latitude!,
        address.longitude!,
      );
      const nearest = resolved.nearestWithinRadius;
      if (nearest) {
        return {
          store: {id: nearest.id, name: nearest.name, code: nearest.code},
          matchedBy: 'distance',
          distanceKm: nearest.distanceKm,
          nearbyStores: [],
        };
      }
      nearbyStores = resolved.nearbyBeyondRadius;
      return {store: null, matchedBy: null, distanceKm: null, nearbyStores};
    }

    const pincodeStore = address.pincode
      ? await this.storeAssignmentService.resolveForPincode(address.pincode)
      : null;
    if (pincodeStore) {
      return {
        store: {id: pincodeStore.id, name: pincodeStore.name, code: pincodeStore.code},
        matchedBy: 'pincode',
        distanceKm: null,
        nearbyStores: [],
      };
    }
    return {store: null, matchedBy: null, distanceKm: null, nearbyStores};
  }

  /**
   * Store for a pickup staff are booking: the customer's preferred store when
   * this is their primary address, otherwise the same lookup the customer app
   * uses. A preferred store that has since closed falls through to that lookup.
   */
  async suggestPickupStoreForStaff(address: CustomerAddress): Promise<PickupStoreResolution> {
    if (address.isDefault) {
      const customer = await this.customerRepository.findById(address.customerId);
      const preferred = customer.preferredStoreId
        ? await this.storeAssignmentService.findActiveStore(customer.preferredStoreId)
        : null;
      if (preferred) {
        return {
          store: {id: preferred.id, name: preferred.name, code: preferred.code},
          matchedBy: 'preferred',
          distanceKm: null,
          nearbyStores: [],
        };
      }
    }
    return this.resolvePickupStore(address);
  }

  /**
   * Fills in a saved address's lat/long by geocoding its text when it has
   * no real coordinates, and saves them onto the address so this happens
   * at most once per address. Mutates and returns the same object. A
   * failed geocode (no key, no match, network error) leaves it unchanged.
   */
  async ensureCoordinates(address: CustomerAddress): Promise<CustomerAddress> {
    if (hasRealCoordinates(address.latitude, address.longitude)) return address;
    const geocoded = await this.geocodingService.geocodeAddress(this.toDisplaySnapshot(address));
    if (geocoded) {
      await this.addressRepository.updateById(address.id, {
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
      });
      address.latitude = geocoded.latitude;
      address.longitude = geocoded.longitude;
    }
    return address;
  }

  async findAll(customerId: string): Promise<CustomerAddress[]> {
    return this.addressRepository.find({where: {customerId, isDeleted: false}});
  }

  async findById(id: string): Promise<CustomerAddress> {
    return this.addressRepository.findById(id);
  }

  async update(id: string, data: Partial<CustomerAddress>): Promise<void> {
    if (data.isDefault) {
      const existing = await this.addressRepository.findById(id);
      await this.addressRepository.updateAll(
        {isDefault: false} as any,
        {customerId: existing.customerId, isDefault: true, id: {neq: id} as any},
      );
    }
    await this.addressRepository.updateById(id, data);
  }

  /**
   * Joins an address's fields into the frozen display-text snapshot used by
   * Order.deliveryAddress and PickupRequest.address (when resolved from a
   * saved addressId) — one place for the join order/formatting, reused
   * everywhere an address gets snapshotted at write time.
   */
  toDisplaySnapshot(address: CustomerAddress): string {
    return [
      address.addressLine1,
      address.addressLine2,
      address.doorFloorFlat,
      address.societyName,
      address.landmark,
      address.city,
      address.state,
      address.country,
      address.pincode,
    ]
      .filter(Boolean)
      .join(', ');
  }

  async delete(id: string): Promise<void> {
    const address = await this.addressRepository.findById(id);
    if (address.isDefault) {
      throw new HttpErrors.BadRequest('Cannot delete the default address. Set another address as default first.');
    }
    await this.addressRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
    } as any);
  }
}
