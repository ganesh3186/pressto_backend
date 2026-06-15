import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CustomerTypeMaster, CustomerTypeMasterRelations} from '../models';

export class CustomerTypeMasterRepository extends TimeStampRepositoryMixin<
  CustomerTypeMaster,
  typeof CustomerTypeMaster.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerTypeMaster,
      typeof CustomerTypeMaster.prototype.id,
      CustomerTypeMasterRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerTypeMaster, dataSource);
  }
}
