import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  StorePriceOverride,
  StorePriceOverrideRelations,
} from '../models/store-price-override.model';
import { presstoDataSource } from '../datasources';

export class StorePriceOverrideRepository extends DefaultCrudRepository<
  StorePriceOverride,
  typeof StorePriceOverride.prototype.id,
  StorePriceOverrideRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(StorePriceOverride, dataSource);
  }
}
