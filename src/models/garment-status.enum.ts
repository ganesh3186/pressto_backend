export enum GarmentStatus {
  RECEIVED = 'received',
  IN_INSPECTION = 'in_inspection',
  IN_PROCESS = 'in_process',
  QUALITY_CHECK = 'quality_check',
  READY = 'ready',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  ON_HOLD = 'on_hold',
  // Terminal: garment returned to customer (return approved at any stage)
  RETURNED_TO_CUSTOMER = 'returned_to_customer',
}

export const GARMENT_STATUS_TRANSITIONS: Record<GarmentStatus, GarmentStatus[]> = {
  [GarmentStatus.RECEIVED]:              [GarmentStatus.IN_INSPECTION],
  [GarmentStatus.IN_INSPECTION]:         [GarmentStatus.IN_PROCESS, GarmentStatus.ON_HOLD, GarmentStatus.RETURNED_TO_CUSTOMER],
  [GarmentStatus.IN_PROCESS]:            [GarmentStatus.QUALITY_CHECK, GarmentStatus.ON_HOLD, GarmentStatus.RETURNED_TO_CUSTOMER],
  [GarmentStatus.QUALITY_CHECK]:         [GarmentStatus.READY, GarmentStatus.IN_PROCESS, GarmentStatus.RETURNED_TO_CUSTOMER],
  [GarmentStatus.READY]:                 [GarmentStatus.OUT_FOR_DELIVERY, GarmentStatus.RETURNED_TO_CUSTOMER],
  [GarmentStatus.OUT_FOR_DELIVERY]:      [GarmentStatus.DELIVERED],
  [GarmentStatus.DELIVERED]:             [],
  // on_hold: waiting for customer approval (upgrade) or store exec (damaged/reprocess)
  // can resume to previous stage or be returned
  [GarmentStatus.ON_HOLD]:              [GarmentStatus.IN_INSPECTION, GarmentStatus.IN_PROCESS, GarmentStatus.RETURNED_TO_CUSTOMER],
  [GarmentStatus.RETURNED_TO_CUSTOMER]: [],
};
