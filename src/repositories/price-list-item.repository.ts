import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  PriceListItem,
  PriceListItemRelations,
} from '../models/price-list-item.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class PriceListItemRepository extends TimeStampRepositoryMixin<
  PriceListItem,
  typeof PriceListItem.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PriceListItem,
      typeof PriceListItem.prototype.id,
      PriceListItemRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(PriceListItem, dataSource);
  }
}
