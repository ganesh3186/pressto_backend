import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {Warehouse, WarehouseRelations} from '../models/warehouse.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Region} from '../models';
import {RegionRepository} from './region.repository';

export class WarehouseRepository extends TimeStampRepositoryMixin<
  Warehouse,
  typeof Warehouse.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Warehouse,
      typeof Warehouse.prototype.id,
      WarehouseRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly region: BelongsToAccessor<Region, typeof Warehouse.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RegionRepository') protected regionRepositoryGetter: Getter<RegionRepository>,
  ) {
    super(Warehouse, dataSource);
    this.region = this.createBelongsToAccessorFor('region', regionRepositoryGetter);
    this.registerInclusionResolver('region', this.region.inclusionResolver);
  }
}
