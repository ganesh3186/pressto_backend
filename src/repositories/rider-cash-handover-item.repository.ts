import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {RiderCashHandoverItem, RiderCashHandoverItemRelations} from '../models/rider-cash-handover-item.model';

export class RiderCashHandoverItemRepository extends DefaultCrudRepository<
  RiderCashHandoverItem,
  typeof RiderCashHandoverItem.prototype.id,
  RiderCashHandoverItemRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(RiderCashHandoverItem, dataSource);
  }
}
