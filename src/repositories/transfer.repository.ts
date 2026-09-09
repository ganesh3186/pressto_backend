import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Transfer, TransferRelations} from '../models/transfer.model';

export class TransferRepository extends TimeStampRepositoryMixin<
  Transfer,
  typeof Transfer.prototype.id,
  Constructor<DefaultCrudRepository<Transfer, typeof Transfer.prototype.id, TransferRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Transfer, dataSource);
  }
}
