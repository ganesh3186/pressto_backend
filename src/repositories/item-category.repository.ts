import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  ItemCategory,
  ItemCategoryRelations,
} from '../models/item-category.model';
import { presstoDataSource } from '../datasources';

export class ItemCategoryRepository extends DefaultCrudRepository<
  ItemCategory,
  typeof ItemCategory.prototype.id,
  ItemCategoryRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(ItemCategory, dataSource);
  }
}
