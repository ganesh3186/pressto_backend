import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {RefundDue, RefundDueRelations} from '../models/refund-due.model';

export class RefundDueRepository extends TimeStampRepositoryMixin<
  RefundDue,
  typeof RefundDue.prototype.id,
  Constructor<DefaultCrudRepository<RefundDue, typeof RefundDue.prototype.id, RefundDueRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(RefundDue, dataSource);
  }
}
