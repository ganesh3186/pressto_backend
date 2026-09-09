import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {TransferItem, TransferItemRelations} from '../models/transfer-item.model';

export class TransferItemRepository extends TimeStampRepositoryMixin<
  TransferItem,
  typeof TransferItem.prototype.id,
  Constructor<DefaultCrudRepository<TransferItem, typeof TransferItem.prototype.id, TransferItemRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(TransferItem, dataSource);
  }
}
