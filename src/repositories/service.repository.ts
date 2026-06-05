import { Constructor, inject, Getter} from '@loopback/core';
import { DefaultCrudRepository, repository, BelongsToAccessor, HasManyThroughRepositoryFactory} from '@loopback/repository';
import { Service, ServiceRelations } from '../models/service.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import {ServiceCategory, Media, Item, ServiceItemMapping, ProcessStep, ServiceProcessMapping} from '../models';
import {ServiceCategoryRepository} from './service-category.repository';
import {MediaRepository} from './media.repository';
import {ServiceItemMappingRepository} from './service-item-mapping.repository';
import {ItemRepository} from './item.repository';
import {ServiceProcessMappingRepository} from './service-process-mapping.repository';
import {ProcessStepRepository} from './process-step.repository';

export class ServiceRepository extends TimeStampRepositoryMixin<
  Service,
  typeof Service.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Service,
      typeof Service.prototype.id,
      ServiceRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly serviceCategory: BelongsToAccessor<ServiceCategory, typeof Service.prototype.id>;
  public readonly media: BelongsToAccessor<Media, typeof Service.prototype.id>;

  public readonly items: HasManyThroughRepositoryFactory<Item, typeof Item.prototype.id,
          ServiceItemMapping,
          typeof Service.prototype.id
        >;

  public readonly processSteps: HasManyThroughRepositoryFactory<ProcessStep, typeof ProcessStep.prototype.id,
          ServiceProcessMapping,
          typeof Service.prototype.id
        >;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('ServiceCategoryRepository') protected serviceCategoryRepositoryGetter: Getter<ServiceCategoryRepository>,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>, @repository.getter('ServiceItemMappingRepository') protected serviceItemMappingRepositoryGetter: Getter<ServiceItemMappingRepository>, @repository.getter('ItemRepository') protected itemRepositoryGetter: Getter<ItemRepository>, @repository.getter('ServiceProcessMappingRepository') protected serviceProcessMappingRepositoryGetter: Getter<ServiceProcessMappingRepository>, @repository.getter('ProcessStepRepository') protected processStepRepositoryGetter: Getter<ProcessStepRepository>,
  ) {
    super(Service, dataSource);
    this.processSteps = this.createHasManyThroughRepositoryFactoryFor('processSteps', processStepRepositoryGetter, serviceProcessMappingRepositoryGetter,);
    this.registerInclusionResolver('processSteps', this.processSteps.inclusionResolver);
    this.items = this.createHasManyThroughRepositoryFactoryFor('items', itemRepositoryGetter, serviceItemMappingRepositoryGetter,);
    this.registerInclusionResolver('items', this.items.inclusionResolver);
    this.serviceCategory = this.createBelongsToAccessorFor('serviceCategory', serviceCategoryRepositoryGetter);
    this.registerInclusionResolver('serviceCategory', this.serviceCategory.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}