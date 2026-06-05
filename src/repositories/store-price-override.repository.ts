import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  StorePriceOverride,
  StorePriceOverrideRelations,
} from '../models/store-price-override.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class StorePriceOverrideRepository extends TimeStampRepositoryMixin<
  StorePriceOverride,
  typeof StorePriceOverride.prototype.id,
  Constructor<
    DefaultCrudRepository<
      StorePriceOverride,
      typeof StorePriceOverride.prototype.id,
      StorePriceOverrideRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(StorePriceOverride, dataSource);
  }
}
