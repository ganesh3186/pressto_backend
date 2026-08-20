// Dropped from the frontend's fuller vocabulary: initiated/dispatched (no
// trigger under atomic create-and-send), wrong_scan_removed (no removal
// path this pass), bag_changed (no mid-transfer bag swap in this scope),
// closed (return-batch terminal state, deferred).
export enum TransferCustodyEventType {
  BAG_SCANNED = 'bag_scanned',
  ITEMS_MAPPED = 'items_mapped',
  SENT_OUT = 'sent_out',
  RIDER_ASSIGNED = 'rider_assigned',
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  DISCREPANCY = 'discrepancy',
  BAG_RELEASED = 'bag_released',
  DISCREPANCY_RESOLVED = 'discrepancy_resolved',
}
