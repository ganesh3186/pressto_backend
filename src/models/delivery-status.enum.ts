export enum DeliveryStatus {
  ASSIGNED = 'assigned',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// Valid next-status transitions — enforced at the controller layer, same
// posture as TRANSFER_STATUS_TRANSITIONS/ORDER_STATUS_TRANSITIONS.
export const DELIVERY_STATUS_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  [DeliveryStatus.ASSIGNED]: [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.CANCELLED],
  [DeliveryStatus.OUT_FOR_DELIVERY]: [DeliveryStatus.COMPLETED],
  [DeliveryStatus.COMPLETED]: [],
  [DeliveryStatus.CANCELLED]: [],
};
