import {Entity, model, property} from '@loopback/repository';

@model({settings: {postgresql: {table: 'audit_log', schema: 'public'}}})
export class AuditLog extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // e.g. 'order' | 'garment' | 'payment' | 'approval_request' | 'customer' | 'order_item'
  @property({type: 'string', required: true})
  entityType: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  entityId: string;

  // e.g. 'status_changed' | 'approval_resolved' | 'post_tag_edit' | 'service_upgraded'
  @property({type: 'string', required: true})
  actionType: string;

  // Snapshot of the entity state before the action
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  before?: object;

  // Snapshot of the entity state after the action
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  after?: object;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  performedBy: string;

  @property({type: 'date', defaultFn: 'now'})
  performedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  constructor(data?: Partial<AuditLog>) {
    super(data);
  }
}

export interface AuditLogRelations {}
export type AuditLogWithRelations = AuditLog & AuditLogRelations;
