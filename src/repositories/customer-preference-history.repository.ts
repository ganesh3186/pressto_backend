import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {CustomerPreferenceHistory, CustomerPreferenceHistoryRelations} from '../models';

// Plain DefaultCrudRepository, not TimeStampRepositoryMixin — this is an
// append-only audit table with no updatedAt field (the mixin would try to
// set one on every create() and fail model validation). Same precedent as
// CouponRedemptionRepository/OrderStatusHistoryRepository.
export class CustomerPreferenceHistoryRepository extends DefaultCrudRepository<
  CustomerPreferenceHistory,
  typeof CustomerPreferenceHistory.prototype.id,
  CustomerPreferenceHistoryRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CustomerPreferenceHistory, dataSource);
  }
}
