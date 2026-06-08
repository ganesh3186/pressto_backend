import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {
  StoreServiceMapping,
  StoreServiceMappingRelations,
} from '../models/store-service-mapping.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Store, Service} from '../models';
import {StoreRepository} from './store.repository';
import {ServiceRepository} from './service.repository';

export class StoreServiceMappingRepository extends TimeStampRepositoryMixin<
  StoreServiceMapping,
  typeof StoreServiceMapping.prototype.id,
  Constructor<
    DefaultCrudRepository<
      StoreServiceMapping,
      typeof StoreServiceMapping.prototype.id,
      StoreServiceMappingRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly store: BelongsToAccessor<Store, typeof StoreServiceMapping.prototype.id>;
  public readonly service: BelongsToAccessor<Service, typeof StoreServiceMapping.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
    @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
  ) {
    super(StoreServiceMapping, dataSource);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
    this.service = this.createBelongsToAccessorFor('service', serviceRepositoryGetter);
    this.registerInclusionResolver('service', this.service.inclusionResolver);
  }
}
