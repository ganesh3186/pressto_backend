export enum OrderType {
  STORE_DROPOFF = 'store_dropoff',                           // drops at store, collects from store
  STORE_DROPOFF_HOME_DELIVERY = 'store_dropoff_home_delivery', // drops at store, delivered home
  HOME_PICKUP = 'home_pickup',                               // picked up from home, collects from store
  HOME_PICKUP_HOME_DELIVERY = 'home_pickup_home_delivery',   // full home service
}
