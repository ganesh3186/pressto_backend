import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {AuditLogRepository} from '../repositories/audit-log.repository';
import {AuditLog} from '../models/audit-log.model';

@injectable({scope: BindingScope.TRANSIENT})
export class AuditService {
  constructor(
    @repository(AuditLogRepository) private auditLogRepo: AuditLogRepository,
  ) {}

  async log(params: {
    entityType: string;
    entityId: string;
    actionType: string;
    performedBy: string;
    before?: object;
    after?: object;
    remarks?: string;
  }): Promise<AuditLog> {
    const {v4} = await import('uuid');
    return this.auditLogRepo.create({
      id: v4(),
      entityType: params.entityType,
      entityId: params.entityId,
      actionType: params.actionType,
      performedBy: params.performedBy,
      before: params.before,
      after: params.after,
      remarks: params.remarks,
    });
  }
}
