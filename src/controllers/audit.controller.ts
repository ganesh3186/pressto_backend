import {authenticate} from '@loopback/authentication';
import {repository, Where} from '@loopback/repository';
import {get, param, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {AuditLog} from '../models/audit-log.model';
import {AuditLogRepository} from '../repositories/audit-log.repository';

export class AuditController {
  constructor(
    @repository(AuditLogRepository) private auditLogRepo: AuditLogRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/audit-logs')
  @response(200, {description: 'Audit log entries'})
  async list(
    @param.query.string('entityType') entityType?: string,
    @param.query.string('entityId') entityId?: string,
    @param.query.string('actionType') actionType?: string,
    @param.query.string('performedBy') performedBy?: string,
  ): Promise<object> {
    const where: Where<AuditLog> = {};
    if (entityType) (where as Record<string, unknown>).entityType = entityType;
    if (entityId) (where as Record<string, unknown>).entityId = entityId;
    if (actionType) (where as Record<string, unknown>).actionType = actionType;
    if (performedBy) (where as Record<string, unknown>).performedBy = performedBy;

    const logs = await this.auditLogRepo.find({
      where,
      order: ['performedAt DESC'],
    });
    return {logs};
  }
}
