import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Stain, StainRelations } from '../models/stain.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';

export class StainRepository extends TimeStampRepositoryMixin<
  Stain,
  typeof Stain.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Stain,
      typeof Stain.prototype.id,
      StainRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Stain, dataSource);
  }
}
