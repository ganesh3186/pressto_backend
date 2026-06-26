import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {OrderAdditionalCharge, OrderAdditionalChargeRelations} from '../models/order-additional-charge.model';

export class OrderAdditionalChargeRepository extends TimeStampRepositoryMixin<
  OrderAdditionalCharge,
  typeof OrderAdditionalCharge.prototype.id,
  Constructor<DefaultCrudRepository<OrderAdditionalCharge, typeof OrderAdditionalCharge.prototype.id, OrderAdditionalChargeRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(OrderAdditionalCharge, dataSource);
  }
}
