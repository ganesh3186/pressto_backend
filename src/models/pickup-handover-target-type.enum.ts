// Who the rider is physically handing freshly-picked-up garments to —
// same shape as RiderCashHandoverTargetType, kept as its own enum since
// this governs a different entity (PickupRequest, not PaymentTransaction)
// and the two are free to evolve independently.
export enum PickupHandoverTargetType {
  STORE = 'store',
  RIDER = 'rider',
}
