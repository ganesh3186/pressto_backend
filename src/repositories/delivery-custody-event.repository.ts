import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {DeliveryCustodyEvent, DeliveryCustodyEventRelations} from '../models/delivery-custody-event.model';

export class DeliveryCustodyEventRepository extends DefaultCrudRepository<
  DeliveryCustodyEvent,
  typeof DeliveryCustodyEvent.prototype.id,
  DeliveryCustodyEventRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(DeliveryCustodyEvent, dataSource);
  }
}
