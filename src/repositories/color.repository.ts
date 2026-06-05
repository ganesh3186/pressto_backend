import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Color, ColorRelations } from '../models/color.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class ColorRepository extends TimeStampRepositoryMixin<
  Color,
  typeof Color.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Color,
      typeof Color.prototype.id,
      ColorRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Color, dataSource);
  }
}