import { Constructor, inject, Getter } from '@loopback/core';
import { DefaultCrudRepository, repository, BelongsToAccessor, HasManyThroughRepositoryFactory} from '@loopback/repository';
import { Item, ItemRelations } from '../models/item.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import { Media, ItemCategory, Service, ServiceItemMapping} from '../models';
import { MediaRepository } from './media.repository';
import {ItemCategoryRepository} from './item-category.repository';
import {ServiceItemMappingRepository} from './service-item-mapping.repository';
import {ServiceRepository} from './service.repository';

export class ItemRepository extends TimeStampRepositoryMixin<
  Item,
  typeof Item.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Item,
      typeof Item.prototype.id,
      ItemRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly media: BelongsToAccessor<Media, typeof Item.prototype.id>;

  public readonly itemCategory: BelongsToAccessor<ItemCategory, typeof Item.prototype.id>;

  public readonly services: HasManyThroughRepositoryFactory<Service, typeof Service.prototype.id,
          ServiceItemMapping,
          typeof Item.prototype.id
        >;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>, @repository.getter('ItemCategoryRepository') protected itemCategoryRepositoryGetter: Getter<ItemCategoryRepository>, @repository.getter('ServiceItemMappingRepository') protected serviceItemMappingRepositoryGetter: Getter<ServiceItemMappingRepository>, @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
  ) {
    super(Item, dataSource);
    this.services = this.createHasManyThroughRepositoryFactoryFor('services', serviceRepositoryGetter, serviceItemMappingRepositoryGetter,);
    this.registerInclusionResolver('services', this.services.inclusionResolver);
    this.itemCategory = this.createBelongsToAccessorFor('itemCategory', itemCategoryRepositoryGetter,);
    this.registerInclusionResolver('itemCategory', this.itemCategory.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}
