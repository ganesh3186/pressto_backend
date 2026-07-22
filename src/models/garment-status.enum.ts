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

/**
 * Pipeline position of each status. Used to find the bottleneck of a set of
 * garments — an order (or an order item) is only as far along as its slowest
 * garment. `-1` marks statuses that sit outside the pipeline and are excluded
 * before ranking.
 */
export const GARMENT_STATUS_RANK: Record<GarmentStatus, number> = {
  [GarmentStatus.RECEIVED]:             0,
  [GarmentStatus.IN_INSPECTION]:        1,
  [GarmentStatus.IN_PROCESS]:           2,
  [GarmentStatus.QUALITY_CHECK]:        3,
  [GarmentStatus.READY]:                4,
  [GarmentStatus.OUT_FOR_DELIVERY]:     5,
  [GarmentStatus.DELIVERED]:            6,
  [GarmentStatus.ON_HOLD]:             -1,
  [GarmentStatus.RETURNED_TO_CUSTOMER]: -1,
};

/** Garments still moving through the pipeline — on-hold and returned are not. */
export function isActiveGarmentStatus(status?: GarmentStatus | string | null): boolean {
  return (
    !!status &&
    status !== GarmentStatus.ON_HOLD &&
    status !== GarmentStatus.RETURNED_TO_CUSTOMER
  );
}

/**
 * The stage a group of garments has collectively reached — the least advanced
 * of the active ones. Returns null when every garment is on hold or returned.
 */
export function deriveGarmentGroupStatus(
  statuses: (GarmentStatus | string | undefined | null)[],
): GarmentStatus | null {
  const active = statuses.filter(isActiveGarmentStatus) as GarmentStatus[];
  if (!active.length) return null;
  return active.reduce((slowest, status) =>
    (GARMENT_STATUS_RANK[status] ?? 0) < (GARMENT_STATUS_RANK[slowest] ?? 0) ? status : slowest,
  );
}
