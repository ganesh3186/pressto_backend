import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import {
  ServiceProcessMapping,
  ServiceProcessMappingRelations,
} from '../models/service-process-mapping.model';
import { presstoDataSource } from '../datasources';

export class ServiceProcessMappingRepository extends DefaultCrudRepository<
  ServiceProcessMapping,
  typeof ServiceProcessMapping.prototype.id,
  ServiceProcessMappingRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(ServiceProcessMapping, dataSource);
  }
}
