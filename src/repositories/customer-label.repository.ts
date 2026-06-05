import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {CustomerLabel, CustomerLabelRelations} from '../models/customer-label.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class CustomerLabelRepository extends TimeStampRepositoryMixin<
  CustomerLabel,
  typeof CustomerLabel.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerLabel,
      typeof CustomerLabel.prototype.id,
      CustomerLabelRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerLabel, dataSource);
  }
}
