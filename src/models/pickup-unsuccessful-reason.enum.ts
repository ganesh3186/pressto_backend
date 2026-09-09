// Multi-select reasons a rider can give when a pickup couldn't be
// completed — the app's "Pickup Unsuccessful" screen.
export enum PickupUnsuccessfulReason {
  CUSTOMER_NOT_ANSWERING = 'customer_not_answering',
  NOT_APPROVING_ENTRY = 'not_approving_entry',
  DENIED_PICKUP = 'denied_pickup',
  OTHER = 'other',
}
