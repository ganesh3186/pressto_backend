export enum TransferStatus {
  SENT = 'sent',
  RECEIVED = 'received',
  DISCREPANCY = 'discrepancy',
}

// Valid next-status transitions — enforced at the controller layer, same
// posture as ORDER_STATUS_TRANSITIONS/PICKUP_REQUEST_STATUS_TRANSITIONS.
// No draft/in_transit states this pass — atomic create-and-send means SENT
// is the only starting point, and there's no dispatch-scan step (that
// belongs to driver assignment, deferred) to move through in between.
export const TRANSFER_STATUS_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  [TransferStatus.SENT]: [TransferStatus.RECEIVED, TransferStatus.DISCREPANCY],
  [TransferStatus.RECEIVED]: [],
  [TransferStatus.DISCREPANCY]: [],
};
