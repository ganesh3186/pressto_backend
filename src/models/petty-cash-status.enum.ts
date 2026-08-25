// String values match the admin panel's existing frontend contract exactly
// (src/_mock/petty-cash.js's PETTY_STATUS, already rendered raw as a chip
// label with no translation layer) — kept as-is rather than the codebase's
// usual lowercase-snake convention, to minimize friction once the frontend
// is wired to these real endpoints.
export enum PettyCashStatus {
  PENDING = 'WAPR',
  APPROVED = 'Approved',
  REJECTED = 'Rejected',
}
