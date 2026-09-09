import {Entity, model, property} from '@loopback/repository';
import {RefundDueStatus} from './refund-due-status.enum';
import {RefundReason} from './refund-reason.enum';

// Captured when staff pick 'bank_account' as the payout method — the
// standard NEFT/RTGS-transfer fields, per the client's requirement.
export interface RefundBankDetails {
  accountHolderName: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  branchName?: string;
}

/**
 * "The customer is owed ₹X, here's why" through to "paid" — the deferred
 * refund pipeline shared by Sales Return, Return Item, and Upgrade/Downgrade
 * overpayment. See ApprovalService.createRefundDue/selectPayoutMethod/
 * _applyRefundPayout for the full lifecycle:
 *   PENDING (owed, no method yet) → REQUESTED (method chosen, a
 *   REFUND_PAYOUT ApprovalRequest raised) → PAID (approved, payout executed).
 */
@model({settings: {postgresql: {table: 'refund_due', schema: 'public'}}})
export class RefundDue extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  customerId: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'string', required: true, jsonSchema: {enum: Object.values(RefundReason)}})
  reason: RefundReason;

  // What produced this refund: 'sales_return' | 'garment' | 'order_item'
  @property({type: 'string', required: true})
  sourceType: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  sourceId: string;

  // Human-readable context, e.g. "Credit Note CN-202609-00003"
  @property({type: 'string'})
  sourceLabel?: string;

  @property({
    type: 'string',
    default: RefundDueStatus.PENDING,
    jsonSchema: {enum: Object.values(RefundDueStatus)},
  })
  status?: RefundDueStatus;

  // 'wallet' | 'bank_account' | 'cash' — set once staff pick a method
  @property({type: 'string'})
  method?: string;

  // Only populated when method === 'bank_account'
  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  bankDetails?: RefundBankDetails;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  approvalRequestId?: string;

  @property({type: 'date'})
  resolvedAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<RefundDue>) {
    super(data);
  }
}

export interface RefundDueRelations {}
export type RefundDueWithRelations = RefundDue & RefundDueRelations;
