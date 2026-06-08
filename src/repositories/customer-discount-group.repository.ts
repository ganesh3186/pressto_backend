import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {CustomerDiscountGroup, CustomerDiscountGroupRelations} from '../models/customer-discount-group.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class CustomerDiscountGroupRepository extends TimeStampRepositoryMixin<
  CustomerDiscountGroup,
  typeof CustomerDiscountGroup.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerDiscountGroup,
      typeof CustomerDiscountGroup.prototype.id,
      CustomerDiscountGroupRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerDiscountGroup, dataSource);
  }
}
