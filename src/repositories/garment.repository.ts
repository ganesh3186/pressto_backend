import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Garment, GarmentRelations} from '../models/garment.model';

export class GarmentRepository extends TimeStampRepositoryMixin<
  Garment,
  typeof Garment.prototype.id,
  Constructor<DefaultCrudRepository<Garment, typeof Garment.prototype.id, GarmentRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(Garment, dataSource);
  }
}
