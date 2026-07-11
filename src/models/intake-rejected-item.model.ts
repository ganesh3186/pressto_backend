import {Entity, model, property} from '@loopback/repository';

export enum IntakeRejectionReason {
  CUSTOMER_DECLINED = 'customer_declined',
  WRONG_ITEM = 'wrong_item',
  TOO_DAMAGED = 'too_damaged',
  NOT_ACCEPTED = 'not_accepted',
  OTHER = 'other',
}

export enum IntakeRejectionOutcome {
  PROCESS_ANYWAY = 'process_anyway',
  UPGRADE = 'upgrade',
  RETURN_TO_CUSTOMER = 'return_to_customer',
}

export enum IntakeRejectionStatus {
  PENDING = 'pending',
  RESOLVED = 'resolved',
}

@model({settings: {postgresql: {table: 'intake_rejected_item', schema: 'public'}}})
export class IntakeRejectedItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderItemId: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  garmentId?: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(IntakeRejectionReason)},
  })
  reason: IntakeRejectionReason;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  mediaIds?: string[];

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  handledBy: string;

  @property({type: 'date', defaultFn: 'now'})
  handledAt?: Date;

  @property({
    type: 'string',
    default: IntakeRejectionStatus.PENDING,
    jsonSchema: {enum: Object.values(IntakeRejectionStatus)},
  })
  status?: IntakeRejectionStatus;

  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(IntakeRejectionOutcome)},
  })
  outcome?: IntakeRejectionOutcome;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  outcomeRemarks?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  resolvedBy?: string;

  @property({type: 'date'})
  resolvedAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<IntakeRejectedItem>) {
    super(data);
  }
}

export interface IntakeRejectedItemRelations {}
export type IntakeRejectedItemWithRelations = IntakeRejectedItem & IntakeRejectedItemRelations;
