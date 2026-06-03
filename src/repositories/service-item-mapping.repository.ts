import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {
  ServiceItemMapping,
  ServiceItemMappingRelations,
} from '../models/service-item-mapping.model';

export class ServiceItemMappingRepository extends DefaultCrudRepository<
  ServiceItemMapping,
  typeof ServiceItemMapping.prototype.id,
  ServiceItemMappingRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(ServiceItemMapping, dataSource);
  }
}
