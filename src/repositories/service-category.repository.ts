import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, HasManyRepositoryFactory} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {ServiceCategory, ServiceCategoryRelations, Service} from '../models';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import {ServiceRepository} from './service.repository';

export class ServiceCategoryRepository extends TimeStampRepositoryMixin<
  ServiceCategory,
  typeof ServiceCategory.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ServiceCategory,
      typeof ServiceCategory.prototype.id,
      ServiceCategoryRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly services: HasManyRepositoryFactory<Service, typeof ServiceCategory.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource, @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
  ) {
    super(ServiceCategory, dataSource);
    this.services = this.createHasManyRepositoryFactoryFor('services', serviceRepositoryGetter,);
    this.registerInclusionResolver('services', this.services.inclusionResolver);
  }
}
