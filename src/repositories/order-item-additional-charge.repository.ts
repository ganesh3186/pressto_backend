import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {OrderItemAdditionalCharge, OrderItemAdditionalChargeRelations} from '../models/order-item-additional-charge.model';

export class OrderItemAdditionalChargeRepository extends TimeStampRepositoryMixin<
  OrderItemAdditionalCharge,
  typeof OrderItemAdditionalCharge.prototype.id,
  Constructor<DefaultCrudRepository<OrderItemAdditionalCharge, typeof OrderItemAdditionalCharge.prototype.id, OrderItemAdditionalChargeRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(OrderItemAdditionalCharge, dataSource);
  }
}
