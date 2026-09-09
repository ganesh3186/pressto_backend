// Who the rider is physically handing the cash to. STORE covers both
// "Washing Facility" and "Nearby Store" in the app's UI — both are just a
// Store record, distinguished by that store's own storeType, not a
// separate concept here. RIDER covers both "Van" and "Rider" in the UI —
// both are just a Rider record, distinguished by that rider's own
// riderType (van-rider vs rider).
export enum RiderCashHandoverTargetType {
  STORE = 'store',
  RIDER = 'rider',
}
