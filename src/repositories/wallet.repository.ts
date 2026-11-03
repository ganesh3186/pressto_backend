import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, HasManyRepositoryFactory, Options, repository} from '@loopback/repository';
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

  /**
   * Adds delta (negative to deduct) to the balance and returns the new balance,
   * or null if the wallet doesn't exist or a deduction would overdraw it.
   *
   * This is the only safe way to change a balance. One statement lets Postgres
   * serialize concurrent changes, where a read-then-write in Node makes the
   * second writer overwrite the first and can spend the same money twice. The
   * row stays locked until the caller's transaction ends.
   */
  async adjustBalance(walletId: string, delta: number, options?: Options): Promise<number | null> {
    const result = await this.execute(
      `UPDATE public.wallet
          SET currentbalance = ROUND(COALESCE(currentbalance, 0) + $1::numeric, 2),
              updatedat = NOW()
        WHERE id = $2
          AND ($1::numeric >= 0 OR COALESCE(currentbalance, 0) + $1::numeric >= 0)
        RETURNING currentbalance`,
      [delta, walletId],
      options,
    );
    const row = result.rows?.[0];
    return row ? Number(row.currentbalance) : null;
  }
}
