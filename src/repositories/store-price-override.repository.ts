import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {StorePriceOverride, StorePriceOverrideRelations} from '../models/store-price-override.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Store} from '../models';
import {StoreRepository} from './store.repository';

export class StorePriceOverrideRepository extends TimeStampRepositoryMixin<
  StorePriceOverride,
  typeof StorePriceOverride.prototype.id,
  Constructor<
    DefaultCrudRepository<
      StorePriceOverride,
      typeof StorePriceOverride.prototype.id,
      StorePriceOverrideRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly store: BelongsToAccessor<Store, typeof StorePriceOverride.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
  ) {
    super(StorePriceOverride, dataSource);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
  }
}
