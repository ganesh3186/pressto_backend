import { Constructor, inject, Getter } from '@loopback/core';
import { DefaultCrudRepository, repository, BelongsToAccessor, HasManyRepositoryFactory} from '@loopback/repository';
import { ItemCategory, ItemCategoryRelations } from '../models/item-category.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import { Media, Item} from '../models';
import { MediaRepository } from './media.repository';
import {ItemRepository} from './item.repository';

export class ItemCategoryRepository extends TimeStampRepositoryMixin<
  ItemCategory,
  typeof ItemCategory.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ItemCategory,
      typeof ItemCategory.prototype.id,
      ItemCategoryRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly media: BelongsToAccessor<Media, typeof ItemCategory.prototype.id>;

  public readonly items: HasManyRepositoryFactory<Item, typeof ItemCategory.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>, @repository.getter('ItemRepository') protected itemRepositoryGetter: Getter<ItemRepository>,
  ) {
    super(ItemCategory, dataSource);
    this.items = this.createHasManyRepositoryFactoryFor('items', itemRepositoryGetter,);
    this.registerInclusionResolver('items', this.items.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}
