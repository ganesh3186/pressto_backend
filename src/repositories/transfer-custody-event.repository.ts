import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TransferCustodyEvent, TransferCustodyEventRelations} from '../models/transfer-custody-event.model';

export class TransferCustodyEventRepository extends DefaultCrudRepository<
  TransferCustodyEvent,
  typeof TransferCustodyEvent.prototype.id,
  TransferCustodyEventRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(TransferCustodyEvent, dataSource);
  }
}
