import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Brand, BrandRelations } from '../models/brand.model';
import { presstoDataSource } from '../datasources';

export class BrandRepository extends DefaultCrudRepository<
  Brand,
  typeof Brand.prototype.id,
  BrandRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(Brand, dataSource);
  }
}
