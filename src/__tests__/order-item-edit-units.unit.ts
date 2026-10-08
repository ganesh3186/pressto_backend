import {expect} from '@loopback/testlab';
import {
  hasEditUnitCharges,
  orderGarmentsForRemoval,
  planEditUnitSlots,
  priceEditedLine,
  resolveEditUnitAreas,
  resolveEditUnitServiceIds,
} from '../services/order-item-edit-units';

const STARCH = 'starch';
const FOLD = 'fold';
const prices: Record<string, number> = {[STARCH]: 50, [FOLD]: 30};
const servicePrice = (id: string) => prices[id] ?? 0;

describe('editing order items per unit (PUT /orders/{id}/items)', () => {
  describe('resolveEditUnitServiceIds', () => {
    it('keeps a service picked for one unit on that unit only', () => {
      expect(
        resolveEditUnitServiceIds(
          2,
          [{additionalServiceIds: []}, {additionalServiceIds: [STARCH]}],
          [STARCH], // line-level union the admin panel also sends
        ),
      ).to.eql([[], [STARCH]]);
    });

    it('falls back to the line-level list for a unit that sends none', () => {
      expect(
        resolveEditUnitServiceIds(
          3,
          [{additionalServiceIds: [FOLD]}, {}],
          [STARCH],
        ),
      ).to.eql([[FOLD], [STARCH], [STARCH]]);
    });

    it('applies the line-level list to every unit when no units are sent', () => {
      expect(resolveEditUnitServiceIds(2, undefined, [STARCH])).to.eql([
        [STARCH],
        [STARCH],
      ]);
      expect(resolveEditUnitServiceIds(1, undefined, undefined)).to.eql([[]]);
    });
  });

  describe('priceEditedLine', () => {
    it('charges a unit-level service only on that unit', () => {
      const result = priceEditedLine({
        resolvedPrice: 100,
        deliveryMultiplier: 1,
        unitServiceIds: [[], [STARCH]],
        servicePrice,
      });
      expect(result.unitPrice).to.equal(100);
      expect(result.perUnitTotalPrices).to.eql([100, 150]);
      expect(result.totalPrice).to.equal(250);
    });

    it('matches the old line-level formula when every unit has the same services', () => {
      const unitServiceIds = resolveEditUnitServiceIds(3, undefined, [
        STARCH,
        FOLD,
      ]);
      const result = priceEditedLine({
        resolvedPrice: 99.99,
        deliveryMultiplier: 1.5,
        unitServiceIds,
        servicePrice,
      });
      const oldUnitPrice = parseFloat(((99.99 + 80) * 1.5).toFixed(2));
      expect(result.totalPrice).to.equal(
        parseFloat((oldUnitPrice * 3).toFixed(2)),
      );
      // unitPrice is the base piece price, as createOrder stores it.
      expect(result.unitPrice).to.equal(parseFloat((99.99 * 1.5).toFixed(2)));
    });

    it('prices measurement units by their own area, services included', () => {
      const result = priceEditedLine({
        resolvedPrice: 20,
        deliveryMultiplier: 1,
        unitServiceIds: [[STARCH], []],
        servicePrice,
        unitAreas: [6, 25],
      });
      expect(result.perUnitTotalPrices).to.eql([420, 500]);
      expect(result.totalPrice).to.equal(920);
    });
  });

  describe('planEditUnitSlots', () => {
    const a = {id: 'garment-a'};
    const b = {id: 'garment-b'};

    it('pairs units with their garments by id, whatever the order', () => {
      const plan = planEditUnitSlots(
        2,
        [{id: 'garment-b'}, {id: 'garment-a'}],
        [a, b],
      );
      expect(plan.garmentBySlot).to.eql([b, a]);
      expect(plan.newSlots).to.eql([]);
    });

    it('treats units beyond the kept garments as new pieces', () => {
      const plan = planEditUnitSlots(3, [{id: 'garment-a'}, {}, {}], [a]);
      expect(plan.garmentBySlot).to.eql([a, undefined, undefined]);
      expect(plan.newSlots).to.eql([1, 2]);
    });

    it('pairs by position when units carry no ids', () => {
      const plan = planEditUnitSlots(3, undefined, [a, b]);
      expect(plan.garmentBySlot).to.eql([a, b, undefined]);
      expect(plan.newSlots).to.eql([2]);
    });

    it('fills id-less units with the garments no unit claimed', () => {
      const plan = planEditUnitSlots(2, [{}, {id: 'garment-a'}], [a, b]);
      expect(plan.garmentBySlot).to.eql([b, a]);
    });

    it('reports garments left over when they outnumber the quantity', () => {
      const plan = planEditUnitSlots(1, [{id: 'garment-b'}], [a, b]);
      expect(plan.garmentBySlot).to.eql([b]);
      expect(plan.unassignedGarments).to.eql([a]);
    });
  });

  describe('hasEditUnitCharges', () => {
    it('is true when any unit sends its own charge list, even an empty one', () => {
      expect(hasEditUnitCharges([{additionalChargeIds: []}, {}])).to.be.true();
      expect(hasEditUnitCharges([{}, {}])).to.be.false();
      expect(hasEditUnitCharges(undefined)).to.be.false();
    });
  });

  describe('resolveEditUnitAreas', () => {
    it('uses the unit measurements, else the stored garment measurements', () => {
      const {areas, dimensions} = resolveEditUnitAreas(
        2,
        [{length: 2, width: 3}, {}],
        [
          {id: 'g1', length: 1, width: 1},
          {id: 'g2', length: 5, width: 5},
        ],
        'curtain',
      );
      expect(areas).to.eql([6, 25]);
      expect(dimensions).to.eql([
        {length: 2, width: 3},
        {length: 5, width: 5},
      ]);
    });

    it('rejects a measurement unit with no usable measurements', () => {
      expect(() =>
        resolveEditUnitAreas(1, [{length: 2}], [undefined], 'curtain'),
      ).to.throw(/needs a length and width/);
    });
  });

  describe('orderGarmentsForRemoval', () => {
    const newestFirst = [{id: 'c'}, {id: 'b'}, {id: 'a'}];

    it('removes the piece the caller no longer lists before any other', () => {
      expect(
        orderGarmentsForRemoval(newestFirst, [{id: 'c'}, {id: 'a'}]).slice(
          0,
          1,
        ),
      ).to.eql([{id: 'b'}]);
    });

    it('keeps newest-first removal when units carry no ids', () => {
      expect(orderGarmentsForRemoval(newestFirst, undefined)).to.eql(
        newestFirst,
      );
      expect(orderGarmentsForRemoval(newestFirst, [{}, {}])).to.eql(
        newestFirst,
      );
    });
  });
});
