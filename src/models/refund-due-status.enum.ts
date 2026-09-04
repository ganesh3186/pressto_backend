export enum RefundDueStatus {
  // Owed, no payout method chosen yet — this is what the invoice dialogue
  // surfaces to staff.
  PENDING = 'pending',
  // A method was chosen and a REFUND_PAYOUT ApprovalRequest was raised;
  // awaiting that approval.
  REQUESTED = 'requested',
  // The approval was granted and the payout actually executed.
  PAID = 'paid',
}
