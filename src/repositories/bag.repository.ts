import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {Bag, BagRelations} from '../models/bag.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class BagRepository extends TimeStampRepositoryMixin<
  Bag,
  typeof Bag.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Bag,
      typeof Bag.prototype.id,
      BagRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Bag, dataSource);
  }
}
