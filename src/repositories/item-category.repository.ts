import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {
  ItemCategory,
  ItemCategoryRelations,
} from '../models/item-category.model';

export class ItemCategoryRepository extends DefaultCrudRepository<
  ItemCategory,
  typeof ItemCategory.prototype.id,
  ItemCategoryRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(ItemCategory, dataSource);
  }
}
