import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {OrderItem, OrderItemRelations} from '../models/order-item.model';

export class OrderItemRepository extends TimeStampRepositoryMixin<
  OrderItem,
  typeof OrderItem.prototype.id,
  Constructor<DefaultCrudRepository<OrderItem, typeof OrderItem.prototype.id, OrderItemRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(OrderItem, dataSource);
  }
}
