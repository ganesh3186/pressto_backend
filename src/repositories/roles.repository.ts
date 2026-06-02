import {Constructor, Getter, inject} from '@loopback/core';
import {DefaultCrudRepository, HasManyThroughRepositoryFactory, repository} from '@loopback/repository';
import {presstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Permissions, RolePermissions, Roles, RolesRelations, UserRoles, Users} from '../models';
import {PermissionsRepository} from './permissions.repository';
import {RolePermissionsRepository} from './role-permissions.repository';
import {UserRolesRepository} from './user-roles.repository';
import {UsersRepository} from './users.repository';

export class RolesRepository extends TimeStampRepositoryMixin<
  Roles,
  typeof Roles.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Roles,
      typeof Roles.prototype.id,
      RolesRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly permissions: HasManyThroughRepositoryFactory<Permissions, typeof Permissions.prototype.id,
    RolePermissions,
    typeof Roles.prototype.id
  >;

  public readonly users: HasManyThroughRepositoryFactory<Users, typeof Users.prototype.id,
    UserRoles,
    typeof Roles.prototype.id
  >;

  constructor(
    @inject('datasources.pressto') dataSource: presstoDataSource, @repository.getter('RolePermissionsRepository') protected rolePermissionsRepositoryGetter: Getter<RolePermissionsRepository>, @repository.getter('PermissionsRepository') protected permissionsRepositoryGetter: Getter<PermissionsRepository>, @repository.getter('UserRolesRepository') protected userRolesRepositoryGetter: Getter<UserRolesRepository>, @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>,
  ) {
    super(Roles, dataSource);
    this.users = this.createHasManyThroughRepositoryFactoryFor('users', usersRepositoryGetter, userRolesRepositoryGetter,);
    this.registerInclusionResolver('users', this.users.inclusionResolver);
    this.permissions = this.createHasManyThroughRepositoryFactoryFor('permissions', permissionsRepositoryGetter, rolePermissionsRepositoryGetter,);
    this.registerInclusionResolver('permissions', this.permissions.inclusionResolver);
  }
}
