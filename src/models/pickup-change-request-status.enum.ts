// PENDING until a real customer-notification channel exists to actually
// tell them (see PickupChangeRequest's own doc comment) — ACKNOWLEDGED is
// a placeholder for once that exists, not reachable by any endpoint yet.
export enum PickupChangeRequestStatus {
  PENDING = 'pending',
  ACKNOWLEDGED = 'acknowledged',
}
