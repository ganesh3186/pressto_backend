import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {SalesReturn, SalesReturnRelations} from '../models/sales-return.model';

export class SalesReturnRepository extends TimeStampRepositoryMixin<
  SalesReturn,
  typeof SalesReturn.prototype.id,
  Constructor<DefaultCrudRepository<SalesReturn, typeof SalesReturn.prototype.id, SalesReturnRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(SalesReturn, dataSource);
  }
}
