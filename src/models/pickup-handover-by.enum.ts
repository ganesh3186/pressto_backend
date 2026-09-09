// Who hands the garments over to the rider at pickup — collected only on
// the customer-facing pickup-request flow (admin/rider-originated requests
// don't ask this).
export enum PickupHandoverBy {
  SELF = 'self',
  FAMILY_MEMBER = 'family_member',
  HOUSEHOLD_HELP = 'household_help',
}
