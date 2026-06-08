import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {Region, RegionRelations} from '../models/region.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class RegionRepository extends TimeStampRepositoryMixin<
  Region,
  typeof Region.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Region,
      typeof Region.prototype.id,
      RegionRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Region, dataSource);
  }
}
