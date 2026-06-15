import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CustomerSecurityDepositTransaction, CustomerSecurityDepositTransactionRelations} from '../models';

export class CustomerSecurityDepositTransactionRepository extends TimeStampRepositoryMixin<
  CustomerSecurityDepositTransaction,
  typeof CustomerSecurityDepositTransaction.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerSecurityDepositTransaction,
      typeof CustomerSecurityDepositTransaction.prototype.id,
      CustomerSecurityDepositTransactionRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerSecurityDepositTransaction, dataSource);
  }
}
