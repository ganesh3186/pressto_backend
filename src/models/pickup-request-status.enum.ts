export enum PickupRequestStatus {
  REQUESTED = 'requested',
  SCHEDULED = 'scheduled',
  RIDER_ASSIGNED = 'rider_assigned',
  OUT_FOR_PICKUP = 'out_for_pickup',
  PICKED_UP = 'picked_up',
  RECEIVED_AT_STORE = 'received_at_store',
  CANCELLED = 'cancelled',
}

// Valid next-status transitions — enforced at the controller layer, same
// posture as ORDER_STATUS_TRANSITIONS in order-status.enum.ts.
export const PICKUP_REQUEST_STATUS_TRANSITIONS: Record<PickupRequestStatus, PickupRequestStatus[]> = {
  [PickupRequestStatus.REQUESTED]: [PickupRequestStatus.SCHEDULED, PickupRequestStatus.CANCELLED],
  [PickupRequestStatus.SCHEDULED]: [PickupRequestStatus.RIDER_ASSIGNED, PickupRequestStatus.CANCELLED],
  [PickupRequestStatus.RIDER_ASSIGNED]: [PickupRequestStatus.OUT_FOR_PICKUP, PickupRequestStatus.CANCELLED],
  [PickupRequestStatus.OUT_FOR_PICKUP]: [PickupRequestStatus.PICKED_UP, PickupRequestStatus.CANCELLED],
  [PickupRequestStatus.PICKED_UP]: [PickupRequestStatus.RECEIVED_AT_STORE],
  [PickupRequestStatus.RECEIVED_AT_STORE]: [],
  [PickupRequestStatus.CANCELLED]: [],
};
