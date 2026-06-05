import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Brand, BrandRelations } from '../models/brand.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class BrandRepository extends TimeStampRepositoryMixin<
  Brand,
  typeof Brand.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Brand,
      typeof Brand.prototype.id,
      BrandRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Brand, dataSource);
  }
}