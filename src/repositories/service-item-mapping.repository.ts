import { Constructor, inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  ServiceItemMapping,
  ServiceItemMappingRelations,
} from '../models/service-item-mapping.model';
import { PresstoDataSource } from '../datasources';
import { TimeStampRepositoryMixin } from '../mixins/timestamp-repository-mixin';
export class ServiceItemMappingRepository extends TimeStampRepositoryMixin<
  ServiceItemMapping,
  typeof ServiceItemMapping.prototype.id,
  Constructor<
    DefaultCrudRepository<
      ServiceItemMapping,
      typeof ServiceItemMapping.prototype.id,
      ServiceItemMappingRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(ServiceItemMapping, dataSource);
  }
}
