import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Order, OrderRelations} from '../models/order.model';

export class OrderRepository extends TimeStampRepositoryMixin<
  Order,
  typeof Order.prototype.id,
  Constructor<DefaultCrudRepository<Order, typeof Order.prototype.id, OrderRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Order, dataSource);
  }
}
