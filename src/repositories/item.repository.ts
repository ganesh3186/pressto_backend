import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Item, ItemRelations} from '../models/item.model';

export class ItemRepository extends DefaultCrudRepository<
  Item,
  typeof Item.prototype.id,
  ItemRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Item, dataSource);
  }
}
