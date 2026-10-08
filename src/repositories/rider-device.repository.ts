import {Constructor, Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Rider, RiderDevice, RiderDeviceRelations} from '../models';
import {RiderRepository} from './rider.repository';

export class RiderDeviceRepository extends TimeStampRepositoryMixin<
  RiderDevice,
  typeof RiderDevice.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RiderDevice,
      typeof RiderDevice.prototype.id,
      RiderDeviceRelations
    >
  >
>(DefaultCrudRepository) {
  public readonly rider: BelongsToAccessor<Rider, typeof RiderDevice.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
  ) {
    super(RiderDevice, dataSource);
    this.rider = this.createBelongsToAccessorFor('rider', riderRepositoryGetter);
    this.registerInclusionResolver('rider', this.rider.inclusionResolver);
  }
}
