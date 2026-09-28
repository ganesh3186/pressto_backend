import {Constructor, Getter, inject} from '@loopback/core';
import {
  BelongsToAccessor,
  DefaultCrudRepository,
  HasManyRepositoryFactory,
  HasManyThroughRepositoryFactory,
  repository,
} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerRelations, Users, CustomerLabel, CustomerLabelAssignment, CustomerPhone} from '../models';
import {UsersRepository} from './users.repository';
import {CustomerLabelRepository} from './customer-label.repository';
import {CustomerLabelAssignmentRepository} from './customer-label-assignment.repository';
import {CustomerPhoneRepository} from './customer-phone.repository';

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

  public readonly customerLabels: HasManyThroughRepositoryFactory<
    CustomerLabel,
    typeof CustomerLabel.prototype.id,
    CustomerLabelAssignment,
    typeof Customer.prototype.id
  >;

  public readonly customerPhones: HasManyRepositoryFactory<CustomerPhone, typeof Customer.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>,
    @repository.getter('CustomerLabelRepository') protected customerLabelRepositoryGetter: Getter<CustomerLabelRepository>,
    @repository.getter('CustomerLabelAssignmentRepository') protected customerLabelAssignmentRepositoryGetter: Getter<CustomerLabelAssignmentRepository>,
    @repository.getter('CustomerPhoneRepository') protected customerPhoneRepositoryGetter: Getter<CustomerPhoneRepository>,
  ) {
    super(Customer, dataSource);
    this.customerPhones = this.createHasManyRepositoryFactoryFor('customerPhones', customerPhoneRepositoryGetter);
    this.registerInclusionResolver('customerPhones', this.customerPhones.inclusionResolver);
    this.customerLabels = this.createHasManyThroughRepositoryFactoryFor(
      'customerLabels',
      customerLabelRepositoryGetter,
      customerLabelAssignmentRepositoryGetter,
    );
    this.registerInclusionResolver('customerLabels', this.customerLabels.inclusionResolver);
    this.user = this.createBelongsToAccessorFor('user', usersRepositoryGetter);
    this.registerInclusionResolver('user', this.user.inclusionResolver);
  }
}
