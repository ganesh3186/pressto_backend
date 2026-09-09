import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {CustomerAddress} from '../models';
import {CustomerAddressRepository, CustomerRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class CustomerAddressService {
  constructor(
    @repository(CustomerAddressRepository)
    private addressRepository: CustomerAddressRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  async create(customerId: string, data: Partial<CustomerAddress>): Promise<CustomerAddress> {
    await this.customerRepository.findById(customerId);

    if (data.isDefault) {
      await this.addressRepository.updateAll(
        {isDefault: false} as any,
        {customerId, isDefault: true},
      );
    }

    return this.addressRepository.create({...data, customerId});
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
