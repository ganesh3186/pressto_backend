import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {GarmentDamage, GarmentDamageRelations} from '../models/garment-damage.model';

export class GarmentDamageRepository extends TimeStampRepositoryMixin<
  GarmentDamage,
  typeof GarmentDamage.prototype.id,
  Constructor<DefaultCrudRepository<GarmentDamage, typeof GarmentDamage.prototype.id, GarmentDamageRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentDamage, dataSource);
  }
}
