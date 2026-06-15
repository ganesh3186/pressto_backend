import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerAddress, CustomerAddressRelations} from '../models';
import {CustomerRepository} from './customer.repository';

export class CustomerAddressRepository extends TimeStampRepositoryMixin<
  CustomerAddress,
  typeof CustomerAddress.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerAddress,
      typeof CustomerAddress.prototype.id,
      CustomerAddressRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof CustomerAddress.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
  ) {
    super(CustomerAddress, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
  }
}
