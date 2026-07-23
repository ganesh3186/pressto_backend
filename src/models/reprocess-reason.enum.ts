/**
 * Why a delivered item is going back through the factory.
 *
 * Grouped for reporting, so "how often is ironing the problem" is answerable.
 * OTHER exists because the list can never be complete — it requires remarks,
 * enforced where the request is raised.
 */
export enum ReprocessReason {
  IRONING_NOT_PROPER = 'ironing_not_proper',
  STAIN_NOT_REMOVED = 'stain_not_removed',
  ODOUR_REMAINING = 'odour_remaining',
  COLOUR_FADED = 'colour_faded',
  DAMAGE_FOUND = 'damage_found',
  WRONG_ITEM = 'wrong_item',
  INCOMPLETE_SERVICE = 'incomplete_service',
  OTHER = 'other',
}

/** Human-readable labels — used by both panels so the wording stays identical. */
export const REPROCESS_REASON_LABELS: Record<ReprocessReason, string> = {
  [ReprocessReason.IRONING_NOT_PROPER]: 'Ironing not proper',
  [ReprocessReason.STAIN_NOT_REMOVED]: 'Stain not removed',
  [ReprocessReason.ODOUR_REMAINING]: 'Odour remaining',
  [ReprocessReason.COLOUR_FADED]: 'Colour faded',
  [ReprocessReason.DAMAGE_FOUND]: 'Damage found',
  [ReprocessReason.WRONG_ITEM]: 'Wrong item delivered',
  [ReprocessReason.INCOMPLETE_SERVICE]: 'Service not completed',
  [ReprocessReason.OTHER]: 'Other',
};

/**
 * How long after delivery a reprocess may still be claimed. Env-driven so the
 * business can tighten or relax it without a deploy; 7 days is the default.
 */
export function reprocessWindowDays(): number {
  const raw = Number(process.env.REPROCESS_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}
