// Multi-select reasons a rider (or admin) can give when a delivery attempt
// couldn't be completed and the order is sent back to the store — the
// app's "Drop Unsuccessful" screen.
export enum DeliveryFailureReason {
  CUSTOMER_NOT_ANSWERING = 'customer_not_answering',
  NOT_APPROVING_ENTRY = 'not_approving_entry',
  OTHER = 'other',
}
