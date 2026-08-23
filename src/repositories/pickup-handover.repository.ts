import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PickupHandover, PickupHandoverRelations} from '../models/pickup-handover.model';

export class PickupHandoverRepository extends TimeStampRepositoryMixin<
  PickupHandover,
  typeof PickupHandover.prototype.id,
  Constructor<DefaultCrudRepository<PickupHandover, typeof PickupHandover.prototype.id, PickupHandoverRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PickupHandover, dataSource);
  }
}
