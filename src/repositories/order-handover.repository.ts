import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {OrderHandover, OrderHandoverRelations} from '../models/order-handover.model';

export class OrderHandoverRepository extends TimeStampRepositoryMixin<
  OrderHandover,
  typeof OrderHandover.prototype.id,
  Constructor<DefaultCrudRepository<OrderHandover, typeof OrderHandover.prototype.id, OrderHandoverRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(OrderHandover, dataSource);
  }
}
