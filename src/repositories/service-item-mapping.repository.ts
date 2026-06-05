import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  ServiceItemMapping,
  ServiceItemMappingRelations,
} from '../models/service-item-mapping.model';
import { presstoDataSource } from '../datasources';

export class ServiceItemMappingRepository extends DefaultCrudRepository<
  ServiceItemMapping,
  typeof ServiceItemMapping.prototype.id,
  ServiceItemMappingRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(ServiceItemMapping, dataSource);
  }
}
