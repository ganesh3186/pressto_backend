export enum TransferStatus {
  SENT = 'sent',
  // Rider assignment is mandatory — a transfer can no longer be received
  // straight from SENT. An admin assigns a rider (POST
  // /transfers/{id}/assign-rider), then the rider marks themself in transit
  // (PATCH /rider/transfers/{id}/status) before the destination store's
  // receive() will accept it.
  RIDER_ASSIGNED = 'rider_assigned',
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  DISCREPANCY = 'discrepancy',
  // Reached only from DISCREPANCY, via POST /transfers/{id}/resolve-discrepancy.
  // Deliberately a distinct terminal state, not a flip back to RECEIVED — it
  // preserves the fact that this transfer WAS discrepant and was later
  // reviewed/closed, rather than papering over the history.
  RESOLVED = 'resolved',
}

// Valid next-status transitions — enforced at the controller layer, same
// posture as ORDER_STATUS_TRANSITIONS/PICKUP_REQUEST_STATUS_TRANSITIONS.
// A transfer is created already SENT (atomic create-and-send, no draft
// state); from there it must be handed to a rider and marked in transit
// before the destination can receive it — see TransferStatus.RIDER_ASSIGNED.
export const TRANSFER_STATUS_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  [TransferStatus.SENT]: [TransferStatus.RIDER_ASSIGNED],
  [TransferStatus.RIDER_ASSIGNED]: [TransferStatus.IN_TRANSIT],
  [TransferStatus.IN_TRANSIT]: [TransferStatus.RECEIVED, TransferStatus.DISCREPANCY],
  [TransferStatus.RECEIVED]: [],
  [TransferStatus.DISCREPANCY]: [TransferStatus.RESOLVED],
  [TransferStatus.RESOLVED]: [],
};
