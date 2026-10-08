import {HttpErrors} from '@loopback/rest';

// Pure helpers for PUT /orders/{id}/items (OrderService.updateOrderItems): per-unit
// additional services, additional charges and measurements on an edited line, priced
// with the same rules createOrder applies at creation.

export type EditAdditionalChargeSelection =
  | string
  | {additionalChargeId: string; quantity: number};

export interface EditOrderUnitInput {
  /** Garment id of an existing piece; absent for a piece added in this edit. */
  id?: string;
  additionalServiceIds?: string[];
  additionalChargeIds?: EditAdditionalChargeSelection[];
  length?: number;
  width?: number;
}

export interface EditLineGarment {
  id: string;
  length?: number | null;
  width?: number | null;
}

export interface EditUnitSlotPlan<G extends EditLineGarment> {
  /** The kept garment each unit slot (0..quantity-1) describes, if any. */
  garmentBySlot: (G | undefined)[];
  /** Unit slots with no garment yet, in the order new garments should take them. */
  newSlots: number[];
  /** Kept garments left without a slot (only when garments outnumber quantity). */
  unassignedGarments: G[];
}

/**
 * Pairs each unit slot with the garment it describes. A unit carrying a garment id
 * gets that garment; the remaining garments (in the given order, oldest tag first)
 * fill the remaining slots in slot order; whatever slots are left are new pieces.
 */
export function planEditUnitSlots<G extends EditLineGarment>(
  quantity: number,
  units: EditOrderUnitInput[] | undefined,
  keptGarments: G[],
): EditUnitSlotPlan<G> {
  const garmentBySlot: (G | undefined)[] = Array.from(
    {length: quantity},
    () => undefined,
  );
  const byId = new Map(keptGarments.map(g => [String(g.id), g]));
  const taken = new Set<string>();

  for (let slot = 0; slot < quantity; slot++) {
    const id = units?.[slot]?.id;
    const garment = id ? byId.get(String(id)) : undefined;
    if (garment && !taken.has(String(garment.id))) {
      garmentBySlot[slot] = garment;
      taken.add(String(garment.id));
    }
  }

  const remaining = keptGarments.filter(g => !taken.has(String(g.id)));
  for (let slot = 0; slot < quantity && remaining.length; slot++) {
    if (!garmentBySlot[slot]) garmentBySlot[slot] = remaining.shift();
  }

  const newSlots: number[] = [];
  garmentBySlot.forEach((garment, slot) => {
    if (!garment) newSlots.push(slot);
  });

  return {garmentBySlot, newSlots, unassignedGarments: remaining};
}

/**
 * Additional services per unit slot: a unit's own list wins (an explicit empty list
 * means "none"); a unit that sends no list — or a caller that sends no units at all —
 * falls back to the line-level list. Same rule as createOrder.
 */
export function resolveEditUnitServiceIds(
  quantity: number,
  units: EditOrderUnitInput[] | undefined,
  lineServiceIds: string[] | undefined,
): string[][] {
  return Array.from(
    {length: quantity},
    (_, slot) => units?.[slot]?.additionalServiceIds ?? lineServiceIds ?? [],
  );
}

/** True when the caller sent garment-wise charge selections for this line. */
export function hasEditUnitCharges(
  units: EditOrderUnitInput[] | undefined,
): boolean {
  return (units ?? []).some(unit => unit?.additionalChargeIds !== undefined);
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n > 0
    ? n
    : null;
}

/**
 * Length × width per unit slot for a measurement item: the unit's own measurements,
 * else the measurements already stored on the garment it describes. Throws (like
 * createOrder) when a slot has neither.
 */
export function resolveEditUnitAreas(
  quantity: number,
  units: EditOrderUnitInput[] | undefined,
  garmentBySlot: (EditLineGarment | undefined)[],
  itemId: string,
): {areas: number[]; dimensions: {length: number; width: number}[]} {
  const dimensions = Array.from({length: quantity}, (_, slot) => {
    const unit = units?.[slot];
    const garment = garmentBySlot[slot];
    const unitLength = positiveNumber(unit?.length);
    const unitWidth = positiveNumber(unit?.width);
    const length =
      unitLength && unitWidth ? unitLength : positiveNumber(garment?.length);
    const width =
      unitLength && unitWidth ? unitWidth : positiveNumber(garment?.width);
    if (!length || !width) {
      throw new HttpErrors.BadRequest(
        `Each unit of a measurement item (itemId: ${itemId}) needs a length and width greater than 0.`,
      );
    }
    return {length, width};
  });
  return {areas: dimensions.map(d => d.length * d.width), dimensions};
}

/**
 * Line pricing from per-unit selections — identical formulas to createOrder:
 * unitPrice is the delivery-multiplied base piece price (no additional services);
 * totalPrice is the sum of each unit's own (base + its own services) × multiplier,
 * times its own area for a measurement item.
 */
export function priceEditedLine(params: {
  resolvedPrice: number;
  deliveryMultiplier: number;
  unitServiceIds: string[][];
  servicePrice: (serviceId: string) => number;
  unitAreas?: number[];
}): {unitPrice: number; perUnitTotalPrices: number[]; totalPrice: number} {
  const {
    resolvedPrice,
    deliveryMultiplier,
    unitServiceIds,
    servicePrice,
    unitAreas,
  } = params;
  const unitPrice = parseFloat((resolvedPrice * deliveryMultiplier).toFixed(2));
  const perUnitTotalPrices = unitServiceIds.map((ids, slot) => {
    const addlAmount = ids.reduce(
      (sum, id) => sum + (servicePrice(id) ?? 0),
      0,
    );
    const perUnitPrice = parseFloat(
      ((resolvedPrice + addlAmount) * deliveryMultiplier).toFixed(2),
    );
    return unitAreas ? perUnitPrice * (unitAreas[slot] ?? 0) : perUnitPrice;
  });
  const totalPrice = parseFloat(
    perUnitTotalPrices.reduce((sum, price) => sum + price, 0).toFixed(2),
  );
  return {unitPrice, perUnitTotalPrices, totalPrice};
}

/**
 * Orders garments for removal when a line shrinks: pieces the caller no longer lists
 * (by garment id) go first, then newest tag first — so removing a specific piece
 * removes that piece, not whichever was tagged last.
 */
export function orderGarmentsForRemoval<G extends {id: string}>(
  garmentsNewestFirst: G[],
  units: EditOrderUnitInput[] | undefined,
): G[] {
  const referenced = new Set(
    (units ?? [])
      .map(unit => unit?.id)
      .filter(Boolean)
      .map(String),
  );
  if (!referenced.size) return garmentsNewestFirst;
  return [
    ...garmentsNewestFirst.filter(g => !referenced.has(String(g.id))),
    ...garmentsNewestFirst.filter(g => referenced.has(String(g.id))),
  ];
}
