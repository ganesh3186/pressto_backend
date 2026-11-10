// Single-select reason an admin gives when cancelling a pickup request —
// the "Cancel pickup request?" dialog's reason dropdown. OTHER unlocks a
// free-text note (cancellationOtherReason).
export enum PickupCancellationReason {
  CUSTOMER_REQUESTED = 'customer_requested',
  CUSTOMER_UNAVAILABLE = 'customer_unavailable',
  DUPLICATE_REQUEST = 'duplicate_request',
  NOT_SERVICEABLE = 'not_serviceable',
  RIDER_UNAVAILABLE = 'rider_unavailable',
  WRONG_DETAILS = 'wrong_details',
  OTHER = 'other',
}
