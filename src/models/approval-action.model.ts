import {Entity, model, property} from '@loopback/repository';
import {ApprovalActionType} from './approval-action-type.enum';

@model({settings: {postgresql: {table: 'approval_action', schema: 'public'}}})
export class ApprovalAction extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  approvalRequestId: string;

  @property({type: 'string', required: true, jsonSchema: {enum: Object.values(ApprovalActionType)}})
  action: ApprovalActionType;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  performedBy: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  comments?: string;

  // Media evidence uploaded when resolving (already-uploaded media UUIDs)
  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  mediaIds?: string[];

  // How was the approval obtained: direct | on_call | in_person | whatsapp | email
  @property({type: 'string'})
  approvalSource?: string;

  // Staff member who approved on behalf of the customer (customer UUID)
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  onBehalfOfCustomerId?: string;

  @property({type: 'date', defaultFn: 'now'})
  actionDate?: Date;

  constructor(data?: Partial<ApprovalAction>) {
    super(data);
  }
}

export interface ApprovalActionRelations {}
export type ApprovalActionWithRelations = ApprovalAction & ApprovalActionRelations;
