import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CouponPriceOverride, CouponPriceOverrideRelations} from '../models';

export class CouponPriceOverrideRepository extends TimeStampRepositoryMixin<
  CouponPriceOverride,
  typeof CouponPriceOverride.prototype.id,
  Constructor<
    DefaultCrudRepository<CouponPriceOverride, typeof CouponPriceOverride.prototype.id, CouponPriceOverrideRelations>
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CouponPriceOverride, dataSource);
  }
}
