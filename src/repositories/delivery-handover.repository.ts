import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  DeliveryHandover,
  DeliveryHandoverRelations,
} from '../models/delivery-handover.model';

export class DeliveryHandoverRepository extends TimeStampRepositoryMixin<
  DeliveryHandover,
  typeof DeliveryHandover.prototype.id,
  Constructor<
    DefaultCrudRepository<
      DeliveryHandover,
      typeof DeliveryHandover.prototype.id,
      DeliveryHandoverRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(DeliveryHandover, dataSource);
  }
}
