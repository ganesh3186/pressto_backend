import { Constructor, inject, Getter} from '@loopback/core';
import { DefaultCrudRepository, repository, BelongsToAccessor} from '@loopback/repository';
import {
  ServiceProcessMapping,
  ServiceProcessMappingRelations,
} from '../models/service-process-mapping.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
import {Roles} from '../models';
import {RolesRepository} from './roles.repository';

export class ServiceProcessMappingRepository extends TimeStampRepositoryMixin<
  ServiceProcessMapping,
  typeof ServiceProcessMapping.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ServiceProcessMapping,
      typeof ServiceProcessMapping.prototype.id,
      ServiceProcessMappingRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly roles: BelongsToAccessor<Roles, typeof ServiceProcessMapping.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource, @repository.getter('RolesRepository') protected rolesRepositoryGetter: Getter<RolesRepository>,
  ) {
    super(ServiceProcessMapping, dataSource);
    this.roles = this.createBelongsToAccessorFor('roles', rolesRepositoryGetter,);
    this.registerInclusionResolver('roles', this.roles.inclusionResolver);
  }
}
