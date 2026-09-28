import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {Customer, CustomerAddress} from '../models';
import {CustomerAddressRepository, CustomerRepository} from '../repositories';
import {StoreAssignmentService} from './store-assignment.service';
import {GeocodingService} from './geocoding.service';

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
    // address saved without the frontend's location picker has no
    // coordinates, so geocode it here too rather than silently never
    // auto-assigning a store for this customer.
    if (address.latitude == null || address.longitude == null) {
      const geocoded = await this.geocodingService.geocodeAddress(
        this.toDisplaySnapshot(address),
      );
      if (geocoded) {
        await this.addressRepository.updateById(address.id, {
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
        });
        address.latitude = geocoded.latitude;
        address.longitude = geocoded.longitude;
      }
    }

    // Self-registered customers have no admin-assigned store. The first
    // address with real coordinates gets one auto-assigned (nearest store
    // within STORE_ASSIGNMENT_RADIUS_KM) so store-scoped features have
    // somewhere to resolve to — never overrides a store an admin, or an
    // earlier address, already set.
    if (!customer.preferredStoreId && address.latitude != null && address.longitude != null) {
      const {nearestWithinRadius} = await this.storeAssignmentService.resolveForCoordinates(
        address.latitude,
        address.longitude,
      );
      if (nearestWithinRadius) {
        await this.customerRepository.updateById(customerId, {
          preferredStoreId: nearestWithinRadius.id,
        } as Partial<Customer>);
      }
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
