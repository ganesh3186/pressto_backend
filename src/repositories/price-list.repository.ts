import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {PriceList, PriceListRelations} from '../models/price-list.model';

export class PriceListRepository extends DefaultCrudRepository<
  PriceList,
  typeof PriceList.prototype.id,
  PriceListRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(PriceList, dataSource);
  }
}
