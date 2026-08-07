import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentAdditionalService, GarmentAdditionalServiceRelations} from '../models/garment-additional-service.model';

export class GarmentAdditionalServiceRepository extends TimeStampRepositoryMixin<
  GarmentAdditionalService,
  typeof GarmentAdditionalService.prototype.id,
  Constructor<DefaultCrudRepository<GarmentAdditionalService, typeof GarmentAdditionalService.prototype.id, GarmentAdditionalServiceRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentAdditionalService, dataSource);
  }
}
