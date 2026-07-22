/**
 * What kind of place an address is.
 *
 * Not yet enforced on CustomerAddress.addressType: that column still carries
 * legacy role values (primary / secondary / delivery, and `billing`, which the
 * business-customer GST flow keys off). Validating against this enum today
 * would reject those writes. Tighten it once billing moves to its own flag.
 */
export enum AddressType {
  HOME = 'home',
  OFFICE = 'office',
  HOTEL = 'hotel',
  OTHER = 'other',
}
