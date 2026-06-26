import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PaymentTransaction, PaymentTransactionRelations} from '../models/payment-transaction.model';

export class PaymentTransactionRepository extends TimeStampRepositoryMixin<
  PaymentTransaction,
  typeof PaymentTransaction.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PaymentTransaction,
      typeof PaymentTransaction.prototype.id,
      PaymentTransactionRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PaymentTransaction, dataSource);
  }
}
