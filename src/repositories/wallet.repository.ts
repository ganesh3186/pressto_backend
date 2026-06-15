import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, HasManyRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Customer, Wallet, WalletRelations, WalletTransaction} from '../models';
import {CustomerRepository} from './customer.repository';
import {WalletTransactionRepository} from './wallet-transaction.repository';

export class WalletRepository extends TimeStampRepositoryMixin<
  Wallet,
  typeof Wallet.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Wallet,
      typeof Wallet.prototype.id,
      WalletRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly customer: BelongsToAccessor<Customer, typeof Wallet.prototype.id>;
  public readonly transactions: HasManyRepositoryFactory<WalletTransaction, typeof Wallet.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('CustomerRepository') protected customerRepositoryGetter: Getter<CustomerRepository>,
    @repository.getter('WalletTransactionRepository') protected walletTransactionRepositoryGetter: Getter<WalletTransactionRepository>,
  ) {
    super(Wallet, dataSource);
    this.customer = this.createBelongsToAccessorFor('customer', customerRepositoryGetter);
    this.registerInclusionResolver('customer', this.customer.inclusionResolver);
    this.transactions = this.createHasManyRepositoryFactoryFor('transactions', walletTransactionRepositoryGetter);
    this.registerInclusionResolver('transactions', this.transactions.inclusionResolver);
  }
}
