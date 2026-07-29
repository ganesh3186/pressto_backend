import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  OrderLabelAssignment,
  OrderLabelAssignmentRelations,
} from '../models';

export class OrderLabelAssignmentRepository extends TimeStampRepositoryMixin<
  OrderLabelAssignment,
  typeof OrderLabelAssignment.prototype.id,
  Constructor<
    DefaultCrudRepository<
      OrderLabelAssignment,
      typeof OrderLabelAssignment.prototype.id,
      OrderLabelAssignmentRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(OrderLabelAssignment, dataSource);
  }
}
