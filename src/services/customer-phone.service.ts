import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {CustomerPhone} from '../models';
import {CustomerPhoneRepository, CustomerRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class CustomerPhoneService {
  constructor(
    @repository(CustomerPhoneRepository)
    private phoneRepository: CustomerPhoneRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  async create(customerId: string, data: Partial<CustomerPhone>): Promise<CustomerPhone> {
    await this.customerRepository.findById(customerId);
    return this.phoneRepository.create({...data, customerId});
  }

  async findAll(customerId: string): Promise<CustomerPhone[]> {
    return this.phoneRepository.find({where: {customerId, isDeleted: false}});
  }

  async findById(id: string): Promise<CustomerPhone> {
    return this.phoneRepository.findById(id);
  }

  async update(id: string, data: Partial<CustomerPhone>): Promise<void> {
    await this.phoneRepository.updateById(id, data);
  }

  async delete(id: string): Promise<void> {
    await this.phoneRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
    } as any);
  }
}
