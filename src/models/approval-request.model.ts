import {Entity, model, property} from '@loopback/repository';
import {
  ApprovalActionType,
  CUSTOMER_RISK_ACTIONS,
  CUSTOMER_UPGRADE_ACTIONS,
} from './approval-action-type.enum';
import {ApprovalRequestStatus} from './approval-request-status.enum';
import {ApprovalRequestType} from './approval-request-type.enum';

// Maps each request type to the role value that should handle it
export const APPROVAL_ROLE_ROUTING: Record<ApprovalRequestType, string> = {
  [ApprovalRequestType.RETURN_ITEM]: 'asm',
  [ApprovalRequestType.UPGRADE_SERVICE]: 'store_exec',
  [ApprovalRequestType.ITEM_DAMAGED]: 'store_exec',
  [ApprovalRequestType.REPROCESS]: 'store_exec',
  [ApprovalRequestType.POST_TAG_EDIT]: 'manager',
  [ApprovalRequestType.CHEQUE_PAYMENT]: 'finance',
  [ApprovalRequestType.PDC_PAYMENT]: 'finance',
  // store_exec can act on the customer's behalf, same as upgrade_service.
  [ApprovalRequestType.PROCESS_AT_RISK]: 'store_exec',
};

// Which of ApprovalActionType a customer may pick, per request type they're
// allowed to see at all (see CUSTOMER_FACING_TYPES in
// customer-approval.controller.ts). Single source of truth for both the
// respond() validation and each view's `availableActions`.
export const CUSTOMER_ACTIONS_BY_TYPE: Partial<Record<ApprovalRequestType, ApprovalActionType[]>> = {
  [ApprovalRequestType.UPGRADE_SERVICE]: CUSTOMER_UPGRADE_ACTIONS,
  [ApprovalRequestType.PROCESS_AT_RISK]: CUSTOMER_RISK_ACTIONS,
};

export {ApprovalActionType, ApprovalRequestStatus, ApprovalRequestType};

@model({settings: {postgresql: {table: 'approval_request', schema: 'public'}}})
export class ApprovalRequest extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, jsonSchema: {enum: Object.values(ApprovalRequestType)}})
  type: ApprovalRequestType;

  // 'order' | 'garment' | 'payment'
  @property({type: 'string', required: true})
  entityType: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  entityId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  requestedBy: string;

  // Role value string that should handle this request (auto-set from APPROVAL_ROLE_ROUTING)
  @property({type: 'string', required: true})
  assignedToRole: string;

  @property({
    type: 'string',
    default: ApprovalRequestStatus.PENDING,
    jsonSchema: {enum: Object.values(ApprovalRequestStatus)},
  })
  status?: ApprovalRequestStatus;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  requestReason?: string;

  // Media evidence uploaded when raising the request (already-uploaded media UUIDs)
  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  mediaIds?: string[];

  // Type-specific extra data — e.g. { toServiceId } for upgrade_service
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  metadata?: Record<string, unknown>;

  @property({type: 'date'})
  resolvedAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<ApprovalRequest>) {
    super(data);
  }
}

export interface ApprovalRequestRelations {}
export type ApprovalRequestWithRelations = ApprovalRequest & ApprovalRequestRelations;
