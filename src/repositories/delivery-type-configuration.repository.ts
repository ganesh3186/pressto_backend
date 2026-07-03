import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {
  DeliveryTypeConfiguration,
  DeliveryTypeConfigurationRelations,
} from '../models/delivery-type-configuration.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class DeliveryTypeConfigurationRepository extends TimeStampRepositoryMixin<
  DeliveryTypeConfiguration,
  typeof DeliveryTypeConfiguration.prototype.id,
  Constructor<
    DefaultCrudRepository<
      DeliveryTypeConfiguration,
      typeof DeliveryTypeConfiguration.prototype.id,
      DeliveryTypeConfigurationRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(DeliveryTypeConfiguration, dataSource);
  }
}
