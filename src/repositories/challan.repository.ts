import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Challan, ChallanRelations} from '../models/challan.model';

export class ChallanRepository extends TimeStampRepositoryMixin<
  Challan,
  typeof Challan.prototype.id,
  Constructor<DefaultCrudRepository<Challan, typeof Challan.prototype.id, ChallanRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Challan, dataSource);
  }
}
