import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {PickupEscalation, PickupEscalationRelations} from '../models/pickup-escalation.model';

export class PickupEscalationRepository extends TimeStampRepositoryMixin<
  PickupEscalation,
  typeof PickupEscalation.prototype.id,
  Constructor<DefaultCrudRepository<PickupEscalation, typeof PickupEscalation.prototype.id, PickupEscalationRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PickupEscalation, dataSource);
  }
}
