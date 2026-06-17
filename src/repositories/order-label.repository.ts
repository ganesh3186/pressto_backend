import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {OrderLabel, OrderLabelRelations} from '../models/order-label.model';

export class OrderLabelRepository extends TimeStampRepositoryMixin<
  OrderLabel,
  typeof OrderLabel.prototype.id,
  Constructor<
    DefaultCrudRepository<
      OrderLabel,
      typeof OrderLabel.prototype.id,
      OrderLabelRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(OrderLabel, dataSource);
  }
}
