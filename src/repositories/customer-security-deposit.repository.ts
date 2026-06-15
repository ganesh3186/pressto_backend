import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, HasManyRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, CustomerSecurityDeposit, CustomerSecurityDepositRelations, CustomerSecurityDepositTransaction} from '../models';
import {CustomerRepository} from './customer.repository';
import {CustomerSecurityDepositTransactionRepository} from './customer-security-deposit-transaction.repository';

export class CustomerSecurityDepositRepository extends TimeStampRepositoryMixin<
  CustomerSecurityDeposit,
  typeof CustomerSecurityDeposit.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerSecurityDeposit,
      typeof CustomerSecurityDeposit.prototype.id,
      CustomerSecurityDepositRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof CustomerSecurityDeposit.prototype.id>;
  public readonly transactions: HasManyRepositoryFactory<CustomerSecurityDepositTransaction, typeof CustomerSecurityDeposit.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
    @repository.getter('CustomerSecurityDepositTransactionRepository') protected customerSecurityDepositTransactionRepositoryGetter: Getter<CustomerSecurityDepositTransactionRepository>,
  ) {
    super(CustomerSecurityDeposit, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
    this.transactions = this.createHasManyRepositoryFactoryFor('transactions', customerSecurityDepositTransactionRepositoryGetter);
    this.registerInclusionResolver('transactions', this.transactions.inclusionResolver);
  }
}
