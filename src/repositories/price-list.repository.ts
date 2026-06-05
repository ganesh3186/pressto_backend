import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { PriceList, PriceListRelations } from '../models/price-list.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class PriceListRepository extends TimeStampRepositoryMixin<
  PriceList,
  typeof PriceList.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PriceList,
      typeof PriceList.prototype.id,
      PriceListRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(PriceList, dataSource);
  }
}