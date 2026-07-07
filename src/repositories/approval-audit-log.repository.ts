import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {ApprovalAuditLog, ApprovalAuditLogRelations} from '../models/approval-audit-log.model';

export class ApprovalAuditLogRepository extends DefaultCrudRepository<
  ApprovalAuditLog,
  typeof ApprovalAuditLog.prototype.id,
  ApprovalAuditLogRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(ApprovalAuditLog, dataSource);
  }
}
