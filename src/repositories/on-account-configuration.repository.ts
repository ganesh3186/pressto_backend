import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {
  OnAccountConfiguration,
  OnAccountConfigurationRelations,
} from '../models/on-account-configuration.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class OnAccountConfigurationRepository extends TimeStampRepositoryMixin<
  OnAccountConfiguration,
  typeof OnAccountConfiguration.prototype.id,
  Constructor<
    DefaultCrudRepository<
      OnAccountConfiguration,
      typeof OnAccountConfiguration.prototype.id,
      OnAccountConfigurationRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(OnAccountConfiguration, dataSource);
  }
}
