export enum GarmentStatus {
  RECEIVED = 'received',
  IN_INSPECTION = 'in_inspection',
  IN_PROCESS = 'in_process',
  QUALITY_CHECK = 'quality_check',
  READY = 'ready',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  ON_HOLD = 'on_hold',
}

export const GARMENT_STATUS_TRANSITIONS: Record<GarmentStatus, GarmentStatus[]> = {
  [GarmentStatus.RECEIVED]:         [GarmentStatus.IN_INSPECTION],
  [GarmentStatus.IN_INSPECTION]:    [GarmentStatus.IN_PROCESS, GarmentStatus.ON_HOLD],
  [GarmentStatus.IN_PROCESS]:       [GarmentStatus.QUALITY_CHECK, GarmentStatus.ON_HOLD],
  [GarmentStatus.QUALITY_CHECK]:    [GarmentStatus.READY, GarmentStatus.IN_PROCESS],
  [GarmentStatus.READY]:            [GarmentStatus.OUT_FOR_DELIVERY],
  [GarmentStatus.OUT_FOR_DELIVERY]: [GarmentStatus.DELIVERED],
  [GarmentStatus.DELIVERED]:        [],
  [GarmentStatus.ON_HOLD]:          [GarmentStatus.IN_PROCESS],
};
