import {DeliveryType} from '../models/delivery-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';

export const DELIVERY_TIER_RANK = {
  [DeliveryType.STANDARD]: 0,
  [DeliveryType.EXPRESS]: 1,
  [DeliveryType.LIGHTNING]: 2,
};

export function canChangeSplitTier(
  orderStatus: OrderStatus | undefined,
  garmentStatuses: GarmentStatus[],
): boolean {
  return (
    [
      OrderStatus.DRAFT,
      OrderStatus.CONFIRMED,
      OrderStatus.RECEIVED_AT_STORE,
      OrderStatus.IN_INSPECTION,
    ].includes(orderStatus as OrderStatus) &&
    garmentStatuses.every(status =>
      [GarmentStatus.RECEIVED, GarmentStatus.IN_INSPECTION].includes(status),
    )
  );
}

const calendarDay = (date: Date | string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(date));
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};

export function resolveSplitDeliveryTier(
  selectedDate: Date | string | undefined,
  originalDeliveryDate: Date | undefined,
  orderCreatedAt: Date | undefined,
  originalTier: DeliveryType | undefined,
  standardDays: number,
  applyCharges = true,
  canChangeTier = true,
): DeliveryType {
  const current = originalTier ?? DeliveryType.STANDARD;
  if (!applyCharges || !canChangeTier) return current;
  if (!selectedDate || !originalDeliveryDate || !orderCreatedAt) return current;

  const selectedDay = calendarDay(selectedDate);
  const originalDay = calendarDay(originalDeliveryDate);
  if (selectedDay === originalDay) return current;

  const receiptDay = calendarDay(orderCreatedAt);
  const standardDate = new Date(`${receiptDay}T00:00:00Z`);
  standardDate.setUTCDate(
    standardDate.getUTCDate() + Math.max(1, standardDays),
  );
  const standardDay = standardDate.toISOString().slice(0, 10);
  const requested =
    selectedDay === receiptDay
      ? DeliveryType.LIGHTNING
      : selectedDay < standardDay
        ? DeliveryType.EXPRESS
        : DeliveryType.STANDARD;
  const difference =
    DELIVERY_TIER_RANK[requested] - DELIVERY_TIER_RANK[current];
  if (difference > 0 && selectedDay < originalDay) return requested;
  if (difference < 0 && selectedDay > originalDay)
    return requested;
  return current;
}
