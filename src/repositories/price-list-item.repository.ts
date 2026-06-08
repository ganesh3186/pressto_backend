import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {PriceListItem, PriceListItemRelations} from '../models/price-list-item.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PriceList, Service, Item} from '../models';
import {PriceListRepository} from './price-list.repository';
import {ServiceRepository} from './service.repository';
import {ItemRepository} from './item.repository';

export class PriceListItemRepository extends TimeStampRepositoryMixin<
  PriceListItem,
  typeof PriceListItem.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PriceListItem,
      typeof PriceListItem.prototype.id,
      PriceListItemRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly priceList: BelongsToAccessor<PriceList, typeof PriceListItem.prototype.id>;
  public readonly service: BelongsToAccessor<Service, typeof PriceListItem.prototype.id>;
  public readonly item: BelongsToAccessor<Item, typeof PriceListItem.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('PriceListRepository') protected priceListRepositoryGetter: Getter<PriceListRepository>,
    @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
    @repository.getter('ItemRepository') protected itemRepositoryGetter: Getter<ItemRepository>,
  ) {
    super(PriceListItem, dataSource);
    this.priceList = this.createBelongsToAccessorFor('priceList', priceListRepositoryGetter);
    this.registerInclusionResolver('priceList', this.priceList.inclusionResolver);
    this.service = this.createBelongsToAccessorFor('service', serviceRepositoryGetter);
    this.registerInclusionResolver('service', this.service.inclusionResolver);
    this.item = this.createBelongsToAccessorFor('item', itemRepositoryGetter);
    this.registerInclusionResolver('item', this.item.inclusionResolver);
  }
}
