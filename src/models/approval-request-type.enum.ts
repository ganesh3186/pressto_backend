export enum ApprovalRequestType {
  RETURN_ITEM = 'return_item',
  UPGRADE_SERVICE = 'upgrade_service',
  ITEM_DAMAGED = 'item_damaged',
  REPROCESS = 'reprocess',
  POST_TAG_EDIT = 'post_tag_edit',
  CHEQUE_PAYMENT = 'cheque_payment',
  PDC_PAYMENT = 'pdc_payment',
  // Raised during inspection when a garment can't be safely processed as
  // ordered AND no upgrade removes the risk either — the customer decides
  // whether to accept the risk and proceed, or have it returned unprocessed.
  PROCESS_AT_RISK = 'process_at_risk',
  // Deferred refund payout — raised once staff pick a method (wallet / bank
  // account / cash) for a RefundDue row; approving it is the moment the
  // money actually moves. See ApprovalService.selectPayoutMethod/
  // _applyRefundPayout.
  REFUND_PAYOUT = 'refund_payout',
  // Raised from the POS "Update Order" edit when staff remove a whole
  // service line or an attached add-on service — never applied immediately,
  // since that would let revenue quietly disappear from an already-placed
  // order with no oversight. See OrderService.updateOrderItems /
  // ApprovalService._applyOrderItemsDowngrade.
  ORDER_ITEMS_DOWNGRADE = 'order_items_downgrade',
}
