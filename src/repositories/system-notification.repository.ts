import {Constructor, Getter, inject} from '@loopback/core';
import {
  BelongsToAccessor,
  DefaultCrudRepository,
  repository,
} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {SystemNotification, SystemNotificationRelations, Users} from '../models';
import {UsersRepository} from './users.repository';

export class SystemNotificationRepository extends TimeStampRepositoryMixin<
  SystemNotification,
  typeof SystemNotification.prototype.id,
  Constructor<
    DefaultCrudRepository<
      SystemNotification,
      typeof SystemNotification.prototype.id,
      SystemNotificationRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly user: BelongsToAccessor<Users, typeof SystemNotification.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository')
    protected usersRepositoryGetter: Getter<UsersRepository>,
  ) {
    super(SystemNotification, dataSource);
    this.user = this.createBelongsToAccessorFor('user', usersRepositoryGetter);
    this.registerInclusionResolver('user', this.user.inclusionResolver);
  }
}
