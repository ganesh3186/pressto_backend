import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { DamageType, DamageTypeRelations } from '../models/damage-type.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class DamageTypeRepository extends TimeStampRepositoryMixin<
  DamageType,
  typeof DamageType.prototype.id,
  Constructor<
    DefaultCrudRepository<
      DamageType,
      typeof DamageType.prototype.id,
      DamageTypeRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(DamageType, dataSource);
  }
}
