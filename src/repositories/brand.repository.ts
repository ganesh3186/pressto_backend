import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Brand, BrandRelations} from '../models/brand.model';

export class BrandRepository extends DefaultCrudRepository<
  Brand,
  typeof Brand.prototype.id,
  BrandRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Brand, dataSource);
  }
}
