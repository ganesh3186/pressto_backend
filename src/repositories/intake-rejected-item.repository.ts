import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {IntakeRejectedItem, IntakeRejectedItemRelations} from '../models/intake-rejected-item.model';

export class IntakeRejectedItemRepository extends TimeStampRepositoryMixin<
  IntakeRejectedItem,
  typeof IntakeRejectedItem.prototype.id,
  Constructor<DefaultCrudRepository<IntakeRejectedItem, typeof IntakeRejectedItem.prototype.id, IntakeRejectedItemRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(IntakeRejectedItem, dataSource);
  }
}
