import {Entity, model, property} from '@loopback/repository';

/**
 * Custody/trail audit log for a Transfer — modeled directly on
 * ApprovalAuditLog's shape (id, parentId, eventType, remarks?, performedBy,
 * performedAt), no relations.
 */
@model({settings: {postgresql: {table: 'transfer_custody_event', schema: 'public'}}})
export class TransferCustodyEvent extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  transferId: string;

  // Set only for item-level events — none this pass (every event written
  // today is transfer-level), but keeps a future item-level trail query
  // simple without a model change.
  @property({type: 'string'})
  garmentTagNumber?: string;

  // TransferCustodyEventType, stored as a plain string like
  // ApprovalAuditLog.eventType does.
  @property({type: 'string', required: true})
  eventType: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  performedBy: string;

  @property({type: 'date', defaultFn: 'now'})
  performedAt?: Date;

  constructor(data?: Partial<TransferCustodyEvent>) {
    super(data);
  }
}

export interface TransferCustodyEventRelations {}
export type TransferCustodyEventWithRelations = TransferCustodyEvent & TransferCustodyEventRelations;
