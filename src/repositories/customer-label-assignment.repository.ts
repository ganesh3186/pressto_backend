import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  CustomerLabelAssignment,
  CustomerLabelAssignmentRelations,
} from '../models';

export class CustomerLabelAssignmentRepository extends TimeStampRepositoryMixin<
  CustomerLabelAssignment,
  typeof CustomerLabelAssignment.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerLabelAssignment,
      typeof CustomerLabelAssignment.prototype.id,
      CustomerLabelAssignmentRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerLabelAssignment, dataSource);
  }
}
