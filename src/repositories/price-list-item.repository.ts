import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  PriceListItem,
  PriceListItemRelations,
} from '../models/price-list-item.model';
import { presstoDataSource } from '../datasources';

export class PriceListItemRepository extends DefaultCrudRepository<
  PriceListItem,
  typeof PriceListItem.prototype.id,
  PriceListItemRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(PriceListItem, dataSource);
  }
}
