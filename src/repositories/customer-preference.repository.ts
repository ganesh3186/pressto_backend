import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CustomerPreference, CustomerPreferenceRelations} from '../models';

export class CustomerPreferenceRepository extends TimeStampRepositoryMixin<
  CustomerPreference,
  typeof CustomerPreference.prototype.id,
  Constructor<
    DefaultCrudRepository<CustomerPreference, typeof CustomerPreference.prototype.id, CustomerPreferenceRelations>
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CustomerPreference, dataSource);
  }
}
