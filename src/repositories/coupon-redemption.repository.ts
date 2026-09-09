import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {CouponRedemption, CouponRedemptionRelations} from '../models';

// Plain DefaultCrudRepository, not TimeStampRepositoryMixin — this is an
// append-only audit table with no updatedAt field (the mixin would try to
// set one on every create() and fail model validation). Same precedent as
// DeliveryCustodyEventRepository/TransferCustodyEventRepository.
export class CouponRedemptionRepository extends DefaultCrudRepository<
  CouponRedemption,
  typeof CouponRedemption.prototype.id,
  CouponRedemptionRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CouponRedemption, dataSource);
  }
}
