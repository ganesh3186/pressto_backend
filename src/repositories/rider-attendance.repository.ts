import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Rider, RiderAttendance, RiderAttendanceRelations} from '../models';
import {RiderRepository} from './rider.repository';

export class RiderAttendanceRepository extends TimeStampRepositoryMixin<
  RiderAttendance,
  typeof RiderAttendance.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RiderAttendance,
      typeof RiderAttendance.prototype.id,
      RiderAttendanceRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly rider: BelongsToAccessor<Rider, typeof RiderAttendance.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
  ) {
    super(RiderAttendance, dataSource);
    this.rider = this.createBelongsToAccessorFor('rider', riderRepositoryGetter);
    this.registerInclusionResolver('rider', this.rider.inclusionResolver);
  }
}
