import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { PriceList, PriceListRelations } from '../models/price-list.model';
import { presstoDataSource } from '../datasources';

export class PriceListRepository extends DefaultCrudRepository<
  PriceList,
  typeof PriceList.prototype.id,
  PriceListRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(PriceList, dataSource);
  }
}
