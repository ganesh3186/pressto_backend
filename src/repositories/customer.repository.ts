import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerRelations, Users, CustomerLabel} from '../models';
import {UsersRepository} from './users.repository';
import {CustomerLabelRepository} from './customer-label.repository';

export class CustomerRepository extends TimeStampRepositoryMixin<
  Customer,
  typeof Customer.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Customer,
      typeof Customer.prototype.id,
      CustomerRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly user: BelongsToAccessor<Users, typeof Customer.prototype.id>;

  public readonly customerLabel: BelongsToAccessor<CustomerLabel, typeof Customer.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>, @repository.getter('CustomerLabelRepository') protected customerLabelRepositoryGetter: Getter<CustomerLabelRepository>,
  ) {
    super(Customer, dataSource);
    this.customerLabel = this.createBelongsToAccessorFor('customerLabel', customerLabelRepositoryGetter,);
    this.registerInclusionResolver('customerLabel', this.customerLabel.inclusionResolver);
    this.user = this.createBelongsToAccessorFor('user', usersRepositoryGetter);
    this.registerInclusionResolver('user', this.user.inclusionResolver);
  }
}
