import {expect} from '@loopback/testlab';
import {DeliveryType} from '../models/delivery-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {
  canChangeSplitTier,
  resolveSplitDeliveryTier,
} from '../services/split-delivery-tier';

describe('split delivery tier', () => {
  const received = new Date('2026-09-12T05:00:00Z');
  const originalDelivery = new Date('2026-09-17T00:00:00Z');

  it('does not charge Lightning for an overdue order moved to a later date', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-10-12T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.STANDARD,
        3,
      ),
    ).to.equal(DeliveryType.STANDARD);
  });

  it('keeps an existing Lightning charge when the customer collects later', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-19T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.LIGHTNING,
        3,
        false,
      ),
    ).to.equal(DeliveryType.LIGHTNING);
  });

  it('upgrades Standard to Express for an earlier delivery after receipt day', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-14T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.STANDARD,
        3,
      ),
    ).to.equal(DeliveryType.EXPRESS);
  });

  it('upgrades Standard and Express to Lightning on receipt day', () => {
    for (const tier of [DeliveryType.STANDARD, DeliveryType.EXPRESS]) {
      expect(
        resolveSplitDeliveryTier(
          '2026-09-12T05:00:00Z',
          originalDelivery,
          received,
          tier,
          3,
        ),
      ).to.equal(DeliveryType.LIGHTNING);
    }
  });

  it('never downgrades Express for a shorter date after receipt day', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-14T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.EXPRESS,
        3,
      ),
    ).to.equal(DeliveryType.EXPRESS);
  });

  it('keeps the original tier when staff choose to update only the date', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-12T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.STANDARD,
        3,
        false,
      ),
    ).to.equal(DeliveryType.STANDARD);
  });

  it('derives lower tiers from date and standard service TAT', () => {
    const sameDay = new Date('2026-09-12T12:00:00Z');
    expect(
      resolveSplitDeliveryTier(
        '2026-09-13T12:00:00Z',
        sameDay,
        received,
        DeliveryType.LIGHTNING,
        3,
      ),
    ).to.equal(DeliveryType.EXPRESS);
    expect(
      resolveSplitDeliveryTier(
        '2026-09-15T12:00:00Z',
        sameDay,
        received,
        DeliveryType.LIGHTNING,
        3,
      ),
    ).to.equal(DeliveryType.STANDARD);
    expect(
      resolveSplitDeliveryTier(
        '2026-09-15T12:00:00Z',
        new Date('2026-09-13T12:00:00Z'),
        received,
        DeliveryType.EXPRESS,
        3,
      ),
    ).to.equal(DeliveryType.STANDARD);
  });

  it('does not lower the tier for the same or an earlier delivery date', () => {
    for (const date of ['2026-09-17T00:00:00Z', '2026-09-16T00:00:00Z']) {
      expect(
        resolveSplitDeliveryTier(
          date,
          originalDelivery,
          received,
          DeliveryType.LIGHTNING,
          3,
          true,
        ),
      ).to.equal(DeliveryType.LIGHTNING);
    }
  });

  it('keeps the original charge when date-only choice conflicts with a lower tier', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-18T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.LIGHTNING,
        3,
        false,
      ),
    ).to.equal(DeliveryType.LIGHTNING);
  });

  it('keeps a higher tier after ready and preserves tier for a time-only change', () => {
    const sameDay = new Date('2026-09-12T12:00:00Z');
    expect(
      resolveSplitDeliveryTier(
        '2026-09-15T12:00:00Z',
        sameDay,
        received,
        DeliveryType.LIGHTNING,
        3,
        true,
        false,
      ),
    ).to.equal(DeliveryType.LIGHTNING);
    expect(
      resolveSplitDeliveryTier(
        '2026-09-12T14:00:00Z',
        sameDay,
        received,
        DeliveryType.LIGHTNING,
        3,
      ),
    ).to.equal(DeliveryType.LIGHTNING);
  });

  it('does not add rush charges after ready', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-14T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.STANDARD,
        3,
        true,
        false,
      ),
    ).to.equal(DeliveryType.STANDARD);
  });

  it('allows tier changes with processing and ready garments, but not when all are ready', () => {
    expect(
      canChangeSplitTier(OrderStatus.IN_INSPECTION, [GarmentStatus.RECEIVED]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.IN_INSPECTION, [
        GarmentStatus.IN_INSPECTION,
      ]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.IN_PROCESS, [GarmentStatus.RECEIVED]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.QUALITY_CHECK, [GarmentStatus.RECEIVED]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.READY, [GarmentStatus.RECEIVED]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.IN_INSPECTION, [GarmentStatus.IN_PROCESS]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.QUALITY_CHECK, [GarmentStatus.QUALITY_CHECK]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.IN_INSPECTION, [GarmentStatus.READY]),
    ).to.equal(false);
    expect(
      canChangeSplitTier(OrderStatus.IN_PROCESS, [
        GarmentStatus.IN_PROCESS,
        GarmentStatus.READY,
      ]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.READY, [
        GarmentStatus.IN_PROCESS,
        GarmentStatus.READY,
      ]),
    ).to.equal(true);
    expect(
      canChangeSplitTier(OrderStatus.READY, [GarmentStatus.READY]),
    ).to.equal(false);
    expect(
      canChangeSplitTier(OrderStatus.IN_PROCESS, [
        GarmentStatus.IN_PROCESS,
        GarmentStatus.OUT_FOR_DELIVERY,
      ]),
    ).to.equal(false);
  });

  it('changes the date-based tier for a processing and ready selection', () => {
    expect(
      resolveSplitDeliveryTier(
        '2026-09-14T00:00:00Z',
        originalDelivery,
        received,
        DeliveryType.STANDARD,
        3,
        true,
        canChangeSplitTier(OrderStatus.READY, [
          GarmentStatus.IN_PROCESS,
          GarmentStatus.READY,
        ]),
      ),
    ).to.equal(DeliveryType.EXPRESS);
  });
});
