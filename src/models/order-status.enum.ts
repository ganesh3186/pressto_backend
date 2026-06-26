export enum OrderStatus {
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  RECEIVED_AT_STORE = 'received_at_store',
  IN_INSPECTION = 'in_inspection',
  IN_PROCESS = 'in_process',
  QUALITY_CHECK = 'quality_check',
  READY = 'ready',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  ON_HOLD = 'on_hold',
}

// Valid next-status transitions — enforced at the service layer
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.RECEIVED_AT_STORE, OrderStatus.CANCELLED],
  [OrderStatus.RECEIVED_AT_STORE]: [OrderStatus.IN_INSPECTION, OrderStatus.CANCELLED],
  [OrderStatus.IN_INSPECTION]: [OrderStatus.IN_PROCESS, OrderStatus.ON_HOLD, OrderStatus.CANCELLED],
  [OrderStatus.ON_HOLD]: [OrderStatus.IN_PROCESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROCESS]: [OrderStatus.QUALITY_CHECK, OrderStatus.CANCELLED],
  [OrderStatus.QUALITY_CHECK]: [OrderStatus.READY, OrderStatus.IN_PROCESS],
  [OrderStatus.READY]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};
