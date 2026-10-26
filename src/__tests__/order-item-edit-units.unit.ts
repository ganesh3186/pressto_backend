import {expect} from '@loopback/testlab';
import {DeliveryType} from '../models/delivery-type.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderService} from '../services/order.service';
import {
  editedGarmentFields,
  hasEditUnitCharges,
  orderGarmentsForRemoval,
  planEditUnitSlots,
  priceEditedLine,
  resolveEditUnitAreas,
  resolveEditUnitServiceIds,
  resolveFreeReprocessSlots,
  splitEditIntakeReturns,
} from '../services/order-item-edit-units';

const STARCH = 'starch';
const FOLD = 'fold';
const prices: Record<string, number> = {[STARCH]: 50, [FOLD]: 30};
const servicePrice = (id: string) => prices[id] ?? 0;

describe('editing order items per unit (PUT /orders/{id}/items)', () => {
  it('keeps a declined piece separate and free of services and charges', () => {
    const [accepted, returned] = splitEditIntakeReturns([{
      serviceId: 'clean', itemId: 'shirt', quantity: 2,
      rejectedAtIntake: true,
      additionalServiceIds: [STARCH], additionalChargeIds: ['hanger'],
      units: [
        {additionalServiceIds: [STARCH]},
        {rejectedAtIntake: true, rejectionReason: 'customer_declined', rejectionRemarks: 'At counter'},
      ],
    }]);
    expect(accepted.quantity).to.equal(1);
    expect(accepted.rejectedAtIntake).to.equal(false);
    expect(returned).to.containEql({
      quantity: 1, rejectedAtIntake: true, rejectionReason: 'customer_declined',
      rejectionRemarks: 'At counter', additionalServiceIds: [], additionalChargeIds: [],
    });
    expect(priceEditedLine({
      resolvedPrice: 0, deliveryMultiplier: 1, unitServiceIds: [[]], servicePrice,
    }).totalPrice).to.equal(0);
  });

  it('does not tag an item returned at intake during an edit', async () => {
    let created = false;
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderItemRepo: {find: async () => [{id: 'returned', quantity: 1, rejectedAtIntake: true}]},
      garmentRepo: {count: async () => ({count: 0}), create: async () => {created = true;}},
    }) as OrderService;
    const autoCreate = service as unknown as {
      autoCreateGarments: (orderId: string, changedBy: string, makeId: () => string) => Promise<object[]>;
    };
    const garments = await autoCreate.autoCreateGarments('order-1', 'staff-1', () => 'id');
    expect(garments).to.eql([]);
    expect(created).to.equal(false);
  });

  it('removes legacy tags from an intake return even when its quantity stays the same', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      garmentRepo: {find: async () => [{id: 'old-tag', garmentTagNumber: 'GT1', status: 'received'}]},
    }) as OrderService;
    const collect = service as unknown as {
      collectRemovableGarments: (items: object[], desired: Map<string, object>, key: (serviceId: string, itemId: string, rejected?: boolean) => string) => Promise<{id: string}[]>;
    };
    const key = (serviceId: string, itemId: string, rejected?: boolean) => `${serviceId}::${itemId}::${Boolean(rejected)}`;
    const desired = new Map([[key('clean', 'kids', true), {quantity: 1}]]);
    const removed = await collect.collectRemovableGarments(
      [{id: 'return-row', serviceId: 'clean', itemId: 'kids', quantity: 1, rejectedAtIntake: true}],
      desired,
      key,
    );
    expect(removed.map(garment => garment.id)).to.eql(['old-tag']);
  });

  it('keeps an edited intake return at zero in the saved order item', async () => {
    let saved: Record<string, unknown> = {};
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({
        id: 'order-1', storeId: 'store-1', customerId: 'customer-1',
        status: OrderStatus.RECEIVED_AT_STORE, deliveryTypePercentage: 0,
      })},
      orderItemRepo: {
        find: async () => [{
          id: 'returned-1', serviceId: 'clean', itemId: 'kids',
          quantity: 1, rejectedAtIntake: true,
        }],
        updateById: async (_id: string, fields: Record<string, unknown>) => {saved = fields;},
      },
      orderItemChargeRepo: {deleteAll: async () => {}},
      garmentRepo: {find: async () => []},
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
      statusHistoryRepo: {create: async () => {}},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      getReprocessOriginalLines: async () => new Map(),
      collectRemovableGarments: async () => [],
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({basePrice: 135, resolvedPrice: 135, priceSource: 'catalog'}),
      normalizeAdditionalCharges: () => [],
      autoCreateGarments: async () => [],
      recalculateOrderTotals: async () => ({totalAmount: 0}),
    }) as OrderService;

    await service.updateOrderItems('order-1', [{
      serviceId: 'clean', itemId: 'kids', quantity: 1,
      units: [{rejectedAtIntake: true, rejectionReason: 'customer_declined'}],
    }], 'staff-1');
    expect(saved).to.containEql({
      rejectedAtIntake: true, rejectionReason: 'customer_declined',
      unitPrice: 0, totalPrice: 0, basePrice: 0, resolvedPrice: 0,
    });
  });

  it('saves the return photo when a new declined item is added in an edit', async () => {
    let savedReturn: Record<string, unknown> = {};
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({
        id: 'order-1', storeId: 'store-1', customerId: 'customer-1',
        status: OrderStatus.RECEIVED_AT_STORE, deliveryTypePercentage: 0,
      })},
      orderItemRepo: {find: async () => [], create: async () => ({id: 'returned-1'})},
      orderItemChargeRepo: {deleteAll: async () => {}},
      garmentRepo: {find: async () => []},
      serviceRepo: {findOne: async () => ({name: 'Clean'})},
      itemRepo: {findById: async () => ({name: 'Shirt/Kids'})},
      intakeRejectedRepo: {create: async (record: Record<string, unknown>) => {savedReturn = record;}},
      dataSource: {beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}})},
      statusHistoryRepo: {create: async () => {}},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      getReprocessOriginalLines: async () => new Map(),
      collectRemovableGarments: async () => [],
      resolveAdditionalChargePercentage: async () => 0,
      resolvePricing: async () => ({basePrice: 135, resolvedPrice: 135, priceSource: 'catalog'}),
      normalizeAdditionalCharges: () => [],
      autoCreateGarments: async () => [],
      recalculateOrderTotals: async () => ({totalAmount: 0}),
    }) as OrderService;

    await service.updateOrderItems('order-1', [{
      serviceId: 'clean', itemId: 'kids', quantity: 1,
      units: [{
        rejectedAtIntake: true, rejectionReason: 'customer_declined',
        itemPhotoMediaIds: ['photo-1'],
      }],
    }], 'staff-1');
    expect(savedReturn).to.containEql({
      orderItemId: 'returned-1', reason: 'customer_declined', mediaIds: ['photo-1'],
      status: 'resolved', outcome: 'return_to_customer',
    });
  });

  it('rejects an incomplete or unconfigured Express charge', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {findOne: async () => ({status: OrderStatus.RECEIVED_AT_STORE, deliveryTypePercentage: 0})},
      orderItemRepo: {find: async () => []},
      deliveryTypeConfigRepo: {findOne: async () => ({expressPercentage: 20})},
      assertItemsHaveRequiredAdditionalServices: async () => {},
      getReprocessOriginalLines: async () => new Map(),
      collectRemovableGarments: async () => [],
    }) as OrderService;
    let error: unknown;
    try {
      await service.updateOrderItems('order-1', [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}],
        'staff-1', {deliveryType: DeliveryType.EXPRESS, deliveryTypePercentage: 50});
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.match(/Delivery charges changed/);
    try {
      await service.updateOrderItems('order-1', [{serviceId: 'service-1', itemId: 'item-1', quantity: 1}],
        'staff-1', {deliveryType: DeliveryType.EXPRESS});
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.match(/Select a delivery charge/);
  });

  it('updates the selected packaging on a garment without changing unrelated fields', () => {
    expect(
      editedGarmentFields(
        {customerRemarks: 'Hanging — Handle with care', length: 1, width: 1},
        'Packaging — Handle with care',
      ),
    ).to.eql({customerRemarks: 'Packaging — Handle with care'});
    expect(editedGarmentFields({customerRemarks: 'Packaging'}, undefined)).to.eql({});
  });

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
    it('keeps original remote rework pieces free before pickup creates tags', () => {
      const slots = resolveFreeReprocessSlots(planEditUnitSlots(3, undefined, []), new Set(), 2);
      const result = priceEditedLine({
        resolvedPrice: 0,
        deliveryMultiplier: 1,
        unitServiceIds: [[], [], []],
        servicePrice,
        unitBasePrice: slot => slots.has(slot) ? 0 : 100,
      });
      expect([...slots]).to.eql([0, 1]);
      expect(result.perUnitTotalPrices).to.eql([0, 0, 100]);
    });

    it('charges a new reprocess piece while keeping the original piece free', () => {
      const result = priceEditedLine({
        resolvedPrice: 0,
        deliveryMultiplier: 1,
        unitServiceIds: [[STARCH, FOLD], [STARCH, FOLD]],
        servicePrice: (id, slot) => (slot === 0 && id === STARCH ? 0 : servicePrice(id)),
        unitBasePrice: slot => (slot === 0 ? 0 : 100),
      });
      expect(result.unitPrice).to.equal(0);
      expect(result.perUnitTotalPrices).to.eql([30, 180]);
      expect(result.totalPrice).to.equal(210);
    });

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
