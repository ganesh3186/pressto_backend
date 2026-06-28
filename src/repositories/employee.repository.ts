import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Employee, EmployeeRelations, Media, Store, Users} from '../models';
import {MediaRepository} from './media.repository';
import {StoreRepository} from './store.repository';
import {UsersRepository} from './users.repository';

export class EmployeeRepository extends TimeStampRepositoryMixin<
  Employee,
  typeof Employee.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Employee,
      typeof Employee.prototype.id,
      EmployeeRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly user: BelongsToAccessor<Users, typeof Employee.prototype.id>;
  public readonly media: BelongsToAccessor<Media, typeof Employee.prototype.id>;
  public readonly store: BelongsToAccessor<Store, typeof Employee.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('UsersRepository') protected usersRepositoryGetter: Getter<UsersRepository>,
    @repository.getter('MediaRepository') protected mediaRepositoryGetter: Getter<MediaRepository>,
    @repository.getter('StoreRepository') protected storeRepositoryGetter: Getter<StoreRepository>,
  ) {
    super(Employee, dataSource);
    this.user = this.createBelongsToAccessorFor('user', usersRepositoryGetter);
    this.registerInclusionResolver('user', this.user.inclusionResolver);
    this.media = this.createBelongsToAccessorFor('media', mediaRepositoryGetter);
    this.registerInclusionResolver('media', this.media.inclusionResolver);
    this.store = this.createBelongsToAccessorFor('store', storeRepositoryGetter);
    this.registerInclusionResolver('store', this.store.inclusionResolver);
  }
}
