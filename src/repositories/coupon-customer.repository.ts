import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CouponCustomer, CouponCustomerRelations} from '../models';

export class CouponCustomerRepository extends TimeStampRepositoryMixin<
  CouponCustomer,
  typeof CouponCustomer.prototype.id,
  Constructor<
    DefaultCrudRepository<CouponCustomer, typeof CouponCustomer.prototype.id, CouponCustomerRelations>
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CouponCustomer, dataSource);
  }
}
