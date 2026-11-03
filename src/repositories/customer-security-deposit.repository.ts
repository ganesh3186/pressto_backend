import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, HasManyRepositoryFactory, Options, repository} from '@loopback/repository';
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

  /**
   * Adds delta (negative to deduct) to the available balance and returns the new
   * balance, or null if the deposit doesn't exist or a deduction would overdraw
   * it. A top-up also raises depositAmount, the total ever deposited; a deduction
   * leaves it alone.
   *
   * One statement lets Postgres serialize concurrent changes, where a
   * read-then-write in Node makes the second writer overwrite the first. The row
   * stays locked until the caller's transaction ends.
   */
  async adjustBalance(depositId: string, delta: number, options?: Options): Promise<number | null> {
    const result = await this.execute(
      `UPDATE public.customer_security_deposit
          SET availablebalance = ROUND(COALESCE(availablebalance, 0) + $1::numeric, 2),
              depositamount = ROUND(COALESCE(depositamount, 0) + GREATEST($1::numeric, 0), 2),
              updatedat = NOW()
        WHERE id = $2
          AND ($1::numeric >= 0 OR COALESCE(availablebalance, 0) + $1::numeric >= 0)
        RETURNING availablebalance`,
      [delta, depositId],
      options,
    );
    const row = result.rows?.[0];
    return row ? Number(row.availablebalance) : null;
  }
}
