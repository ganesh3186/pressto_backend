import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Coupon, CouponRelations} from '../models';

export class CouponRepository extends TimeStampRepositoryMixin<
  Coupon,
  typeof Coupon.prototype.id,
  Constructor<DefaultCrudRepository<Coupon, typeof Coupon.prototype.id, CouponRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Coupon, dataSource);
  }
}
