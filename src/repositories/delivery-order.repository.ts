import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {DeliveryOrder, DeliveryOrderRelations} from '../models/delivery-order.model';

export class DeliveryOrderRepository extends TimeStampRepositoryMixin<
  DeliveryOrder,
  typeof DeliveryOrder.prototype.id,
  Constructor<DefaultCrudRepository<DeliveryOrder, typeof DeliveryOrder.prototype.id, DeliveryOrderRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(DeliveryOrder, dataSource);
  }
}
