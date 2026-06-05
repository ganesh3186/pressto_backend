import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Color, ColorRelations } from '../models/color.model';
import { presstoDataSource } from '../datasources';

export class ColorRepository extends DefaultCrudRepository<
  Color,
  typeof Color.prototype.id,
  ColorRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(Color, dataSource);
  }
}
