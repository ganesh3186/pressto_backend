import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Delivery, DeliveryRelations} from '../models/delivery.model';

export class DeliveryRepository extends TimeStampRepositoryMixin<
  Delivery,
  typeof Delivery.prototype.id,
  Constructor<DefaultCrudRepository<Delivery, typeof Delivery.prototype.id, DeliveryRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Delivery, dataSource);
  }
}
