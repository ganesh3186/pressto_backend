// Why a RefundDue exists — shown to staff in the invoice dialogue and the
// Finance Refund Payouts approval screen so they know what they're paying
// out for. Sales Return doesn't appear here — it pays out immediately on
// its own credit-note approval instead of going through this deferred
// pipeline (see sales-return.controller.ts's approve()).
export enum RefundReason {
  RETURN_ITEM = 'return_item',
  // A price increase never produces a refund on its own — this value is kept
  // for symmetry/future use, but only DOWNGRADE is ever set today (see
  // ApprovalService._applyUpgradeOnOrderItem).
  UPGRADE = 'upgrade',
  DOWNGRADE = 'downgrade',
}
