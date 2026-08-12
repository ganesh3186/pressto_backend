export enum OrderStatus {
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  RECEIVED_AT_STORE = 'received_at_store',
  IN_INSPECTION = 'in_inspection',
  IN_PROCESS = 'in_process',
  QUALITY_CHECK = 'quality_check',
  READY = 'ready',
  PARTIALLY_DISPATCHED = 'partially_dispatched',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  ON_HOLD = 'on_hold',
  RETURNED = 'returned',
}

// Valid next-status transitions — enforced at the service layer
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.RECEIVED_AT_STORE, OrderStatus.CANCELLED],
  // RETURNED is reachable from every stage below — garments exist from the
  // moment an order is received_at_store, and the return-approval flow can be
  // raised against a garment at any point after that (including immediately
  // at intake, before any processing has started).
  [OrderStatus.RECEIVED_AT_STORE]: [OrderStatus.IN_INSPECTION, OrderStatus.CANCELLED, OrderStatus.RETURNED],
  [OrderStatus.IN_INSPECTION]: [OrderStatus.IN_PROCESS, OrderStatus.ON_HOLD, OrderStatus.CANCELLED, OrderStatus.RETURNED],
  [OrderStatus.ON_HOLD]: [OrderStatus.IN_PROCESS, OrderStatus.CANCELLED, OrderStatus.RETURNED],
  [OrderStatus.IN_PROCESS]: [OrderStatus.QUALITY_CHECK, OrderStatus.CANCELLED, OrderStatus.RETURNED],
  [OrderStatus.QUALITY_CHECK]: [OrderStatus.READY, OrderStatus.IN_PROCESS, OrderStatus.RETURNED],
  [OrderStatus.READY]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.RETURNED],
  // Set only by the split operation — remaining items continue normal flow
  [OrderStatus.PARTIALLY_DISPATCHED]: [OrderStatus.PARTIALLY_DISPATCHED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.ON_HOLD, OrderStatus.CANCELLED, OrderStatus.RETURNED],
  // READY is reachable from here via POST /orders/{id}/delivery-return —
  // a failed/undeliverable customer delivery, distinct from RETURNED
  // (which means the sales-return/refund flow, a permanent terminal state).
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.READY],
  // Set only by the sales-return / garment-return-approval flow, once every
  // item on the order has been returned
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};
