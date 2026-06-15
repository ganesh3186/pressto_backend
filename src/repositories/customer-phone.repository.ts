import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerPhone, CustomerPhoneRelations} from '../models';
import {CustomerRepository} from './customer.repository';

export class CustomerPhoneRepository extends TimeStampRepositoryMixin<
  CustomerPhone,
  typeof CustomerPhone.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerPhone,
      typeof CustomerPhone.prototype.id,
      CustomerPhoneRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof CustomerPhone.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
  ) {
    super(CustomerPhone, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
  }
}
