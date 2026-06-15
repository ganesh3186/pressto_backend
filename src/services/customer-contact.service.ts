import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {CustomerContact} from '../models';
import {CustomerContactRepository, CustomerRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class CustomerContactService {
  constructor(
    @repository(CustomerContactRepository)
    private contactRepository: CustomerContactRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
  ) {}

  async create(customerId: string, data: Partial<CustomerContact>): Promise<CustomerContact> {
    await this.customerRepository.findById(customerId);
    return this.contactRepository.create({...data, customerId});
  }

  async findAll(customerId: string): Promise<CustomerContact[]> {
    return this.contactRepository.find({where: {customerId, isDeleted: false}});
  }

  async findById(id: string): Promise<CustomerContact> {
    return this.contactRepository.findById(id);
  }

  async update(id: string, data: Partial<CustomerContact>): Promise<void> {
    await this.contactRepository.updateById(id, data);
  }

  async delete(id: string): Promise<void> {
    await this.contactRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
    } as any);
  }
}
