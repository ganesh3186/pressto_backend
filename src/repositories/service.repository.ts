import { inject } from '@loopback/core';
import { DefaultCrudRepository } from '@loopback/repository';
import { Service, ServiceRelations } from '../models/service.model';
import { presstoDataSource } from '../datasources';

export class ServiceRepository extends DefaultCrudRepository<
  Service,
  typeof Service.prototype.id,
  ServiceRelations
> {
  constructor(@inject('datasources.pressto') dataSource: presstoDataSource) {
    super(Service, dataSource);
  }
}
