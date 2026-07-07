import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {AuditLog, AuditLogRelations} from '../models/audit-log.model';

export class AuditLogRepository extends DefaultCrudRepository<
  AuditLog,
  typeof AuditLog.prototype.id,
  AuditLogRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(AuditLog, dataSource);
  }
}
