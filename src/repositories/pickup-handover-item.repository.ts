import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {PickupHandoverItem, PickupHandoverItemRelations} from '../models/pickup-handover-item.model';

export class PickupHandoverItemRepository extends DefaultCrudRepository<
  PickupHandoverItem,
  typeof PickupHandoverItem.prototype.id,
  PickupHandoverItemRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PickupHandoverItem, dataSource);
  }
}
