import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, BelongsToAccessor, HasManyRepositoryFactory} from '@loopback/repository';
import {PriceList, PriceListRelations} from '../models/price-list.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Region, PriceListItem} from '../models';
import {RegionRepository} from './region.repository';
import {PriceListItemRepository} from './price-list-item.repository';

export class PriceListRepository extends TimeStampRepositoryMixin<
  PriceList,
  typeof PriceList.prototype.id,
  Constructor<
    DefaultCrudRepository<
      PriceList,
      typeof PriceList.prototype.id,
      PriceListRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly region: BelongsToAccessor<Region, typeof PriceList.prototype.id>;
  public readonly priceListItems: HasManyRepositoryFactory<PriceListItem, typeof PriceList.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RegionRepository') protected regionRepositoryGetter: Getter<RegionRepository>,
    @repository.getter('PriceListItemRepository') protected priceListItemRepositoryGetter: Getter<PriceListItemRepository>,
  ) {
    super(PriceList, dataSource);
    this.region = this.createBelongsToAccessorFor('region', regionRepositoryGetter);
    this.registerInclusionResolver('region', this.region.inclusionResolver);
    this.priceListItems = this.createHasManyRepositoryFactoryFor('priceListItems', priceListItemRepositoryGetter);
    this.registerInclusionResolver('priceListItems', this.priceListItems.inclusionResolver);
  }
}
