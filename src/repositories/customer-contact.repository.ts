import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerContact, CustomerContactRelations} from '../models';
import {CustomerRepository} from './customer.repository';

export class CustomerContactRepository extends TimeStampRepositoryMixin<
  CustomerContact,
  typeof CustomerContact.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerContact,
      typeof CustomerContact.prototype.id,
      CustomerContactRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof CustomerContact.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
  ) {
    super(CustomerContact, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
  }
}
