import {Constructor, inject, Getter} from '@loopback/core';
import {DefaultCrudRepository, repository, HasManyThroughRepositoryFactory, BelongsToAccessor} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {Users, UsersRelations, Roles, UserRoles, Media} from '../models';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {UserRolesRepository} from './user-roles.repository';
import {RolesRepository} from './roles.repository';
import {MediaRepository} from './media.repository';

export class UsersRepository extends TimeStampRepositoryMixin<
  Users,
  typeof Users.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Users,
      typeof Users.prototype.id,
      UsersRelations
    >
  >
>(DefaultCrudRepository) {

  public readonly roles: HasManyThroughRepositoryFactory<Roles, typeof Roles.prototype.id,
          UserRoles,
          typeof Users.prototype.id
        >;

  public readonly media: BelongsToAccessor<Media, typeof Users.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UserRolesRepository') protected userRolesRepositoryGetter: Getter<UserRolesRepository>,
    @repository.getter('RolesRepository') protected rolesRepositoryGetter: Getter<RolesRepository>,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>,
  ) {
    super(Users, dataSource);
    this.roles = this.createHasManyThroughRepositoryFactoryFor('roles', rolesRepositoryGetter, userRolesRepositoryGetter,);
    this.registerInclusionResolver('roles', this.roles.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
  }
}