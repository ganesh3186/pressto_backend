import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {
  GstTaxConfiguration,
  GstTaxConfigurationRelations,
} from '../models/gst-tax-configuration.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class GstTaxConfigurationRepository extends TimeStampRepositoryMixin<
  GstTaxConfiguration,
  typeof GstTaxConfiguration.prototype.id,
  Constructor<
    DefaultCrudRepository<
      GstTaxConfiguration,
      typeof GstTaxConfiguration.prototype.id,
      GstTaxConfigurationRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(GstTaxConfiguration, dataSource);
  }
}
