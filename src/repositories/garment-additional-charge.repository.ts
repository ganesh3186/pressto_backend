import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {
  GarmentAdditionalCharge,
  GarmentAdditionalChargeRelations,
} from '../models/garment-additional-charge.model';

export class GarmentAdditionalChargeRepository extends TimeStampRepositoryMixin<
  GarmentAdditionalCharge,
  typeof GarmentAdditionalCharge.prototype.id,
  Constructor<DefaultCrudRepository<GarmentAdditionalCharge, typeof GarmentAdditionalCharge.prototype.id, GarmentAdditionalChargeRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentAdditionalCharge, dataSource);
  }
}
