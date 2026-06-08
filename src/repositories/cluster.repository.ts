import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {Cluster, ClusterRelations} from '../models/cluster.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Region} from '../models';
import {RegionRepository} from './region.repository';

export class ClusterRepository extends TimeStampRepositoryMixin<
  Cluster,
  typeof Cluster.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Cluster,
      typeof Cluster.prototype.id,
      ClusterRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly region: BelongsToAccessor<Region, typeof Cluster.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RegionRepository') protected regionRepositoryGetter: Getter<RegionRepository>,
  ) {
    super(Cluster, dataSource);
    this.region = this.createBelongsToAccessorFor('region', regionRepositoryGetter);
    this.registerInclusionResolver('region', this.region.inclusionResolver);
  }
}
