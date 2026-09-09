import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Rider, RiderRelations, Users} from '../models';
import {UsersRepository} from './users.repository';

export class RiderRepository extends TimeStampRepositoryMixin<
  Rider,
  typeof Rider.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Rider,
      typeof Rider.prototype.id,
      RiderRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly user: BelongsToAccessor<Users, typeof Rider.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>,
  ) {
    super(Rider, dataSource);
    this.user = this.createBelongsToAccessorFor('user', usersRepositoryGetter);
    this.registerInclusionResolver('user', this.user.inclusionResolver);
  }
}
