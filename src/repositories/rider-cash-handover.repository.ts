import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {RiderCashHandover, RiderCashHandoverRelations} from '../models/rider-cash-handover.model';

export class RiderCashHandoverRepository extends TimeStampRepositoryMixin<
  RiderCashHandover,
  typeof RiderCashHandover.prototype.id,
  Constructor<DefaultCrudRepository<RiderCashHandover, typeof RiderCashHandover.prototype.id, RiderCashHandoverRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(RiderCashHandover, dataSource);
  }
}
