import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {Store, StoreRelations} from '../models/store.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Cluster} from '../models';
import {ClusterRepository} from './cluster.repository';

export class StoreRepository extends TimeStampRepositoryMixin<
  Store,
  typeof Store.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Store,
      typeof Store.prototype.id,
      StoreRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly cluster: BelongsToAccessor<Cluster, typeof Store.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('ClusterRepository') protected clusterRepositoryGetter: Getter<ClusterRepository>,
  ) {
    super(Store, dataSource);
    this.cluster = this.createBelongsToAccessorFor('cluster', clusterRepositoryGetter);
    this.registerInclusionResolver('cluster', this.cluster.inclusionResolver);
  }
}
