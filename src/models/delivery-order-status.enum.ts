// Per-stop progress and outcome within a Delivery run, separate from Order.status.
export enum DeliveryOrderStatus {
  PENDING = 'pending',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  ARRIVED = 'arrived',
  DELIVERED = 'delivered',
  RETURN_TO_STORE = 'return_to_store',
}
