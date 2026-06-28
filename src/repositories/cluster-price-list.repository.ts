import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {ClusterPriceList, ClusterPriceListRelations} from '../models/cluster-price-list.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Cluster} from '../models';
import {ClusterRepository} from './cluster.repository';

export class ClusterPriceListRepository extends TimeStampRepositoryMixin<
  ClusterPriceList,
  typeof ClusterPriceList.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ClusterPriceList,
      typeof ClusterPriceList.prototype.id,
      ClusterPriceListRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly cluster: BelongsToAccessor<Cluster, typeof ClusterPriceList.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('ClusterRepository') protected clusterRepositoryGetter: Getter<ClusterRepository>,
  ) {
    super(ClusterPriceList, dataSource);
    this.cluster = this.createBelongsToAccessorFor('cluster', clusterRepositoryGetter);
    this.registerInclusionResolver('cluster', this.cluster.inclusionResolver);
  }
}
