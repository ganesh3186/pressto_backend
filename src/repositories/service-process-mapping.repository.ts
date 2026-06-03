import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {
  ServiceProcessMapping,
  ServiceProcessMappingRelations,
} from '../models/service-process-mapping.model';

export class ServiceProcessMappingRepository extends DefaultCrudRepository<
  ServiceProcessMapping,
  typeof ServiceProcessMapping.prototype.id,
  ServiceProcessMappingRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(ServiceProcessMapping, dataSource);
  }
}
