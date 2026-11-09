import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  DeliveryHandoverItem,
  DeliveryHandoverItemRelations,
} from '../models/delivery-handover-item.model';

export class DeliveryHandoverItemRepository extends TimeStampRepositoryMixin<
  DeliveryHandoverItem,
  typeof DeliveryHandoverItem.prototype.id,
  Constructor<
    DefaultCrudRepository<
      DeliveryHandoverItem,
      typeof DeliveryHandoverItem.prototype.id,
      DeliveryHandoverItemRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(DeliveryHandoverItem, dataSource);
  }
}
