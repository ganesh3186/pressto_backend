// Not to be confused with PickupRequestStatus/PickupRequest — this enum is
// about how a FINISHED order reaches the customer (store_pickup = customer
// collects from the counter; home_delivery = rider drops it off). A
// PickupRequest is the opposite end of the lifecycle entirely: a rider
// collecting a customer's dirty laundry from their home, before any Order
// record exists at all. Never conflate the two.
export enum OrderDeliveryMethod {
  STORE_PICKUP = 'store_pickup',
  HOME_DELIVERY = 'home_delivery',
}
