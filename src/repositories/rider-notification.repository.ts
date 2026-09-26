import {Getter, inject} from '@loopback/core';
import {BelongsToAccessor, DefaultCrudRepository, repository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {Rider, RiderNotification, RiderNotificationRelations} from '../models';
import {RiderRepository} from './rider.repository';

// Plain DefaultCrudRepository, not TimeStampRepositoryMixin — this is an
// append-only history log with no updatedAt field (the mixin would try to
// set one on every create() and fail model validation). Same precedent as
// CouponRedemptionRepository/DeliveryCustodyEventRepository.
export class RiderNotificationRepository extends DefaultCrudRepository<
  RiderNotification,
  typeof RiderNotification.prototype.id,
  RiderNotificationRelations
> {
  public readonly rider: BelongsToAccessor<Rider, typeof RiderNotification.prototype.id>;

  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
    @repository.getter('RiderRepository') protected riderRepositoryGetter: Getter<RiderRepository>,
  ) {
    super(RiderNotification, dataSource);
    this.rider = this.createBelongsToAccessorFor('rider', riderRepositoryGetter);
    this.registerInclusionResolver('rider', this.rider.inclusionResolver);
  }
}
