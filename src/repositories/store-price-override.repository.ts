import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {StorePriceOverride, StorePriceOverrideRelations} from '../models/store-price-override.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Store, Service, Item} from '../models';
import {StoreRepository} from './store.repository';
import {ServiceRepository} from './service.repository';
import {ItemRepository} from './item.repository';

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
  public readonly service: BelongsToAccessor<Service, typeof StorePriceOverride.prototype.id>;
  public readonly item: BelongsToAccessor<Item, typeof StorePriceOverride.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
    @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
    @repository.getter('ItemRepository') protected itemRepositoryGetter: Getter<ItemRepository>,
  ) {
    super(StorePriceOverride, dataSource);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
    this.service = this.createBelongsToAccessorFor('service', serviceRepositoryGetter);
    this.registerInclusionResolver('service', this.service.inclusionResolver);
    this.item = this.createBelongsToAccessorFor('item', itemRepositoryGetter);
    this.registerInclusionResolver('item', this.item.inclusionResolver);
  }
}
