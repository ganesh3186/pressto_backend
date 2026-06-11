import {Constructor, Getter, inject} from '@loopback/core';
import {DefaultCrudRepository, HasManyThroughRepositoryFactory, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Permissions, PermissionsRelations, RolePermissions, Roles} from '../models';
import {RolePermissionsRepository} from './role-permissions.repository';
import {RolesRepository} from './roles.repository';

export class PermissionsRepository extends TimeStampRepositoryMixin<
  Permissions,
  typeof Permissions.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Permissions,
      typeof Permissions.prototype.id,
      PermissionsRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly roles: HasManyThroughRepositoryFactory<
    Roles,
    typeof Roles.prototype.id,
    RolePermissions,
    typeof Permissions.prototype.id
  >;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RolesRepository') protected rolesRepositoryGetter: Getter<RolesRepository>,
    @repository.getter('RolePermissionsRepository') protected rolePermissionsRepositoryGetter: Getter<RolePermissionsRepository>,
  ) {
    super(Permissions, dataSource);
    this.roles = this.createHasManyThroughRepositoryFactoryFor(
      'roles',
      rolesRepositoryGetter,
      rolePermissionsRepositoryGetter,
    );
    this.registerInclusionResolver('roles', this.roles.inclusionResolver);
  }
}
