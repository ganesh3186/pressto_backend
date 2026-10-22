import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  StoreMonthlyTarget,
  StoreMonthlyTargetRelations,
} from '../models/store-monthly-target.model';

export class StoreMonthlyTargetRepository extends TimeStampRepositoryMixin<
  StoreMonthlyTarget,
  typeof StoreMonthlyTarget.prototype.id,
  Constructor<
    DefaultCrudRepository<
      StoreMonthlyTarget,
      typeof StoreMonthlyTarget.prototype.id,
      StoreMonthlyTargetRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(StoreMonthlyTarget, dataSource);
  }
}
