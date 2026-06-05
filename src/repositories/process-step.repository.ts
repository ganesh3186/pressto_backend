import { Constructor, inject, Getter} from '@loopback/core';
import { DefaultCrudRepository, repository, BelongsToAccessor, HasManyThroughRepositoryFactory} from '@loopback/repository';
import { ProcessStep, ProcessStepRelations } from '../models/process-step.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import {Media, Service, ServiceProcessMapping} from '../models';
import {MediaRepository} from './media.repository';
import {ServiceProcessMappingRepository} from './service-process-mapping.repository';
import {ServiceRepository} from './service.repository';

export class ProcessStepRepository extends TimeStampRepositoryMixin<
  ProcessStep,
  typeof ProcessStep.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ProcessStep,
      typeof ProcessStep.prototype.id,
      ProcessStepRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly media: BelongsToAccessor<Media, typeof ProcessStep.prototype.id>;

  public readonly services: HasManyThroughRepositoryFactory<Service, typeof Service.prototype.id,
          ServiceProcessMapping,
          typeof ProcessStep.prototype.id
        >;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource, @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>, @repository.getter('ServiceProcessMappingRepository') protected serviceProcessMappingRepositoryGetter: Getter<ServiceProcessMappingRepository>, @repository.getter('ServiceRepository') protected serviceRepositoryGetter: Getter<ServiceRepository>,
  ) {
    super(ProcessStep, dataSource);
    this.services = this.createHasManyThroughRepositoryFactoryFor('services', serviceRepositoryGetter, serviceProcessMappingRepositoryGetter,);
    this.registerInclusionResolver('services', this.services.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter,);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}
