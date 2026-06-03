import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {
  StorePriceOverride,
  StorePriceOverrideRelations,
} from '../models/store-price-override.model';

export class StorePriceOverrideRepository extends DefaultCrudRepository<
  StorePriceOverride,
  typeof StorePriceOverride.prototype.id,
  StorePriceOverrideRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(StorePriceOverride, dataSource);
  }
}
