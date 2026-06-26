import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentStain, GarmentStainRelations} from '../models/garment-stain.model';

export class GarmentStainRepository extends TimeStampRepositoryMixin<
  GarmentStain,
  typeof GarmentStain.prototype.id,
  Constructor<DefaultCrudRepository<GarmentStain, typeof GarmentStain.prototype.id, GarmentStainRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentStain, dataSource);
  }
}
