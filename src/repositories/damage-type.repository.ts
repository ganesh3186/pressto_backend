import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { DamageType, DamageTypeRelations } from '../models/damage-type.model';
import { presstoDataSource } from '../datasources';

export class DamageTypeRepository extends DefaultCrudRepository<
  DamageType,
  typeof DamageType.prototype.id,
  DamageTypeRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(DamageType, dataSource);
  }
}
