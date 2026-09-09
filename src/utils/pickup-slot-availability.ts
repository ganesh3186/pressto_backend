// Pickup/delivery slots stay the same fixed recurring time-of-day windows
// they've always been — no per-date data. The only new rule: when the
// requested date is today, hide any slot whose window has already
// started or starts within the next 90 minutes, so a customer/rider can't
// pick a slot that's effectively already gone. Any other date shows every
// active slot unfiltered. Shared by both the customer and rider slot
// endpoints so this rule can't drift between them.
const BUFFER_MINUTES = 90;

export function filterSlotsForDate<T extends {startTime?: string}>(
  slots: T[],
  requestedDate: string | undefined,
  now: Date = new Date(),
): T[] {
  if (!requestedDate) return slots;

  const requested = new Date(requestedDate);
  if (requested.toDateString() !== now.toDateString()) return slots;

  const cutoff = new Date(now.getTime() + BUFFER_MINUTES * 60 * 1000);
  const cutoffMinutes = cutoff.getHours() * 60 + cutoff.getMinutes();

  return slots.filter(slot => {
    if (!slot.startTime) return true;
    const [hours, minutes] = slot.startTime.split(':').map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return true;
    return hours * 60 + minutes >= cutoffMinutes;
  });
}
