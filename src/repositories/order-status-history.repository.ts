import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {OrderStatusHistory, OrderStatusHistoryRelations} from '../models/order-status-history.model';

export class OrderStatusHistoryRepository extends DefaultCrudRepository<
  OrderStatusHistory,
  typeof OrderStatusHistory.prototype.id,
  OrderStatusHistoryRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(OrderStatusHistory, dataSource);
  }
}
