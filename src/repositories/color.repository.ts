import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Color, ColorRelations} from '../models/color.model';

export class ColorRepository extends DefaultCrudRepository<
  Color,
  typeof Color.prototype.id,
  ColorRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Color, dataSource);
  }
}
