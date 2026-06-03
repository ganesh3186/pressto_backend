import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {DamageType, DamageTypeRelations} from '../models/damage-type.model';

export class DamageTypeRepository extends DefaultCrudRepository<
  DamageType,
  typeof DamageType.prototype.id,
  DamageTypeRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(DamageType, dataSource);
  }
}
