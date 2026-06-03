import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {
  PriceListItem,
  PriceListItemRelations,
} from '../models/price-list-item.model';

export class PriceListItemRepository extends DefaultCrudRepository<
  PriceListItem,
  typeof PriceListItem.prototype.id,
  PriceListItemRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(PriceListItem, dataSource);
  }
}
