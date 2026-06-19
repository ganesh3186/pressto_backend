import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CustomerFamilyGroup, CustomerFamilyGroupRelations} from '../models/customer-family-group.model';

export class CustomerFamilyGroupRepository extends TimeStampRepositoryMixin<
  CustomerFamilyGroup,
  typeof CustomerFamilyGroup.prototype.id,
  Constructor<
    DefaultCrudRepository<
      CustomerFamilyGroup,
      typeof CustomerFamilyGroup.prototype.id,
      CustomerFamilyGroupRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(CustomerFamilyGroup, dataSource);
  }
}
