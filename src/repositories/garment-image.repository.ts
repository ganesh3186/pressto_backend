import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentImage, GarmentImageRelations} from '../models/garment-image.model';

export class GarmentImageRepository extends TimeStampRepositoryMixin<
  GarmentImage,
  typeof GarmentImage.prototype.id,
  Constructor<DefaultCrudRepository<GarmentImage, typeof GarmentImage.prototype.id, GarmentImageRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentImage, dataSource);
  }
}
