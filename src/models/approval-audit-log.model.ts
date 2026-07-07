import {Entity, model, property} from '@loopback/repository';

@model({settings: {postgresql: {table: 'approval_audit_log', schema: 'public'}}})
export class ApprovalAuditLog extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  approvalRequestId: string;

  // 'created' | 'approved' | 'rejected'
  @property({type: 'string', required: true})
  eventType: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  performedBy: string;

  @property({type: 'date', defaultFn: 'now'})
  performedAt?: Date;

  constructor(data?: Partial<ApprovalAuditLog>) {
    super(data);
  }
}

export interface ApprovalAuditLogRelations {}
export type ApprovalAuditLogWithRelations = ApprovalAuditLog & ApprovalAuditLogRelations;
