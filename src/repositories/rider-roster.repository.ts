import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Rider, RiderRoster, RiderRosterRelations} from '../models';
import {RiderRepository} from './rider.repository';

export class RiderRosterRepository extends TimeStampRepositoryMixin<
  RiderRoster,
  typeof RiderRoster.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RiderRoster,
      typeof RiderRoster.prototype.id,
      RiderRosterRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly rider: BelongsToAccessor<Rider, typeof RiderRoster.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
  ) {
    super(RiderRoster, dataSource);
    this.rider = this.createBelongsToAccessorFor('rider', riderRepositoryGetter);
    this.registerInclusionResolver('rider', this.rider.inclusionResolver);
  }
}
