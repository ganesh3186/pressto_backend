import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, HasManyThroughRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerRelations, Users, CustomerLabel, CustomerLabelAssignment} from '../models';
import {UsersRepository} from './users.repository';
import {CustomerLabelRepository} from './customer-label.repository';
import {CustomerLabelAssignmentRepository} from './customer-label-assignment.repository';

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

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>,
    @repository.getter('CustomerLabelRepository') protected customerLabelRepositoryGetter: Getter<CustomerLabelRepository>,
    @repository.getter('CustomerLabelAssignmentRepository') protected customerLabelAssignmentRepositoryGetter: Getter<CustomerLabelAssignmentRepository>,
  ) {
    super(Customer, dataSource);
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
