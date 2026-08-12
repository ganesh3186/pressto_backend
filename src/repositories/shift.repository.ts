import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Shift, ShiftRelations} from '../models/shift.model';

export class ShiftRepository extends TimeStampRepositoryMixin<
  Shift,
  typeof Shift.prototype.id,
  Constructor<DefaultCrudRepository<Shift, typeof Shift.prototype.id, ShiftRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Shift, dataSource);
  }
}
