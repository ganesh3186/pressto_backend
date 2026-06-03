import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Service, ServiceRelations} from '../models/service.model';

export class ServiceRepository extends DefaultCrudRepository<
  Service,
  typeof Service.prototype.id,
  ServiceRelations
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Service, dataSource);
  }
}
