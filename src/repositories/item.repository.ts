import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Item, ItemRelations } from '../models/item.model';
import { presstoDataSource } from '../datasources';

export class ItemRepository extends DefaultCrudRepository<
  Item,
  typeof Item.prototype.id,
  ItemRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(Item, dataSource);
  }
}
