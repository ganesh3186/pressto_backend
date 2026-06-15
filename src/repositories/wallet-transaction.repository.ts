import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {WalletTransaction, WalletTransactionRelations} from '../models';

export class WalletTransactionRepository extends TimeStampRepositoryMixin<
  WalletTransaction,
  typeof WalletTransaction.prototype.id,
  Constructor<
    DefaultCrudRepository<
      WalletTransaction,
      typeof WalletTransaction.prototype.id,
      WalletTransactionRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(WalletTransaction, dataSource);
  }
}
