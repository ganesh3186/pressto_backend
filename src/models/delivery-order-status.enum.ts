// Per-stop breadcrumb within a Delivery run — deliberately NOT the same
// thing as Order.status (ready/out_for_delivery/delivered), which is the
// authoritative record of whether this stop is actually done. This only
// tracks whether the rider has physically reached this stop yet, which
// Order.status has no room for without conflating "on the way" with "here".
export enum DeliveryOrderStatus {
  PENDING = 'pending',
  ARRIVED = 'arrived',
}
