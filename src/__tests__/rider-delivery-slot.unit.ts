import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {RiderDeliveryController} from '../controllers/rider-delivery.controller';
import {DeliveryOrderStatus} from '../models/delivery-order-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';

describe('rider delivery display fields', () => {
  it('returns slot times and bag numbers in both list and detail responses', async () => {
    const delivery = {
      id: 'delivery-1',
      riderId: 'rider-1',
      bagId: 'bag-1',
      deliverySlotId: 'slot-1',
      deliverySlot: 'Twelfth',
      deliveryDate: new Date('2026-11-01T00:00:00Z'),
      assignedAt: new Date('2026-10-31T10:00:00Z'),
    };
    const legacyDelivery = {
      id: 'delivery-2',
      riderId: 'rider-1',
      deliverySlot: '2:00 PM - 5:00 PM',
      deliveryDate: new Date('2026-11-01T00:00:00Z'),
      assignedAt: new Date('2026-10-31T09:00:00Z'),
    };
    let slotQueries = 0;
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({id: 'rider-1'}),
        deliveryRepository: {
          find: async () => [delivery, legacyDelivery],
          findOne: async () => delivery,
        },
        pickupDeliverySlotRepository: {
          find: async () => {
            slotQueries++;
            return [
              {
                id: 'slot-1',
                label: 'Twelfth',
                startTime: '14:00',
                endTime: '17:30',
              },
            ];
          },
        },
        bagRepository: {find: async () => [{id: 'bag-1', bagNumber: 42}]},
        deliveryOrderRepository: {find: async (filter: {where: {deliveryId: unknown}}) =>
          typeof filter.where.deliveryId === 'string' ? [] : [
            {deliveryId: 'delivery-1', orderId: 'order-1'},
            {deliveryId: 'delivery-2', orderId: 'order-2'},
          ]},
        orderRepository: {find: async () => [
          {id: 'order-1', assignedRiderId: 'rider-1', deliverySlotId: 'slot-1',
            deliveryDate: new Date('2026-11-01T00:00:00Z')},
          {id: 'order-2', assignedRiderId: 'rider-1', deliverySlot: '2:00 PM - 5:00 PM',
            deliveryDate: new Date('2026-11-01T00:00:00Z')},
        ]},
      },
    ) as RiderDeliveryController;

    const list = (await controller.myDeliveries({} as UserProfile)) as {
      deliveries: {deliverySlot: string; bagId?: string; bagNumber: number | null}[];
    };
    const detail = (await controller.deliveryDetail(
      {} as UserProfile,
      'delivery-1',
    )) as {
      delivery: {deliverySlot: string; bagId?: string; bagNumber: number | null};
    };

    expect(list.deliveries.map(d => d.deliverySlot)).to.deepEqual([
      '2:00 PM - 5:30 PM',
      '2:00 PM - 5:00 PM',
    ]);
    expect(detail.delivery.deliverySlot).to.equal('2:00 PM - 5:30 PM');
    expect(list.deliveries.map(d => d.bagNumber)).to.deepEqual([42, null]);
    expect(list.deliveries[0].bagId).to.equal(undefined);
    expect(detail.delivery.bagNumber).to.equal(42);
    expect(detail.delivery.bagId).to.equal(undefined);
    expect(slotQueries).to.equal(2);
  });

  it('shows only the latest active run after repeated slot assignments', async () => {
    const date = new Date('2026-11-01T00:00:00Z');
    let currentSlotId = 'slot-2';
    let deletedOrderId = '';
    let reassignOnLock = false;
    const startedOrders: string[] = [];
    const tx = {commit: async () => {}, rollback: async () => {}};
    const runs = [
      {id: 'new', riderId: 'rider-1', status: 'assigned', deliveryDate: date,
        deliverySlotId: 'slot-2', assignedAt: new Date('2026-10-31T11:00:00Z'), orderCount: 1},
      {id: 'old', riderId: 'rider-1', status: 'assigned', deliveryDate: date,
        deliverySlotId: 'slot-2', assignedAt: new Date('2026-10-31T10:00:00Z'), orderCount: 2},
      {id: 'oldest', riderId: 'rider-1', status: 'assigned', deliveryDate: date,
        deliverySlotId: 'slot-1', assignedAt: new Date('2026-10-31T09:00:00Z'), orderCount: 1},
    ];
    const controller = Object.assign(Object.create(RiderDeliveryController.prototype), {
      resolveActiveRider: async () => ({id: 'rider-1'}),
      deliveryRepository: {find: async () => runs, findOne: async () => runs[1],
        updateById: async () => {}},
      deliveryOrderRepository: {find: async (filter: {where: {deliveryId?: string}}) => {
        const stops = [
          {id: 'new-a', deliveryId: 'new', orderId: 'order-1'},
          {id: 'old-a', deliveryId: 'old', orderId: 'order-1'},
          {id: 'old-b', deliveryId: 'old', orderId: 'order-2'},
          {id: 'oldest-a', deliveryId: 'oldest', orderId: 'order-1'},
        ];
        return typeof filter.where.deliveryId === 'string'
          ? stops.filter(stop => stop.deliveryId === filter.where.deliveryId) : stops;
      }, findOne: async () => ({id: 'old-a', deliveryId: 'old', orderId: 'order-1'}),
        updateById: async () => {}},
      orderRepository: {find: async (filter: {where: {id: {inq: string[]}}}) => [
        {id: 'order-1', assignedRiderId: 'rider-1', deliveryDate: date,
          deliverySlotId: currentSlotId, status: 'ready'},
        {id: 'order-2', assignedRiderId: 'rider-1', deliveryDate: date,
          deliverySlotId: 'slot-2', status: 'ready'},
      ].filter(order => filter.where.id.inq.includes(order.id) &&
        (!('isDeleted' in filter.where) || order.id !== deletedOrderId)),
        updateById: async (id: string) => {startedOrders.push(id);}},
      orderItemRepository: {find: async () => []},
      orderService: {computeBalanceDue: async () => ({due: 0})},
      orderStatusHistoryRepository: {create: async () => {}},
      custodyEventRepository: {create: async () => {}},
      dataSource: {beginTransaction: async () => tx, execute: async () => {
        if (reassignOnLock) runs[1].riderId = 'rider-2';
        return [];
      }},
      pickupDeliverySlotRepository: {find: async () => []},
      bagRepository: {find: async () => []},
    }) as RiderDeliveryController;

    const result = await controller.myDeliveries({} as UserProfile, undefined, '2026-11-01') as {
      deliveries: {id: string}[];
    };
    expect(result.deliveries.map(d => d.id)).to.eql(['new', 'old']);
    expect((result.deliveries as {id: string; orderCount: number}[]).map(d => d.orderCount)).to.eql([1, 1]);

    const detail = await controller.deliveryDetail({} as UserProfile, 'old') as {
      orders: {orderId: string}[];
    };
    expect(detail.orders.map(order => order.orderId)).to.eql(['order-2']);
    await expect(controller.markOrderArrived({} as UserProfile, 'old', 'order-1', {
      status: DeliveryOrderStatus.ARRIVED,
    })).to.be.rejectedWith(/no longer on this delivery/);
    await controller.startDelivery({} as UserProfile, 'old', {
      status: DeliveryStatus.OUT_FOR_DELIVERY,
    });
    expect(startedOrders).to.eql(['order-2']);

    currentSlotId = 'slot-3'; // Order metadata changed before assignment completed.
    const afterFailedReschedule = await controller.myDeliveries(
      {} as UserProfile, undefined, '2026-11-01',
    ) as {deliveries: {id: string}[]};
    expect(afterFailedReschedule.deliveries.map(d => d.id)).to.eql(['new', 'old']);

    deletedOrderId = 'order-2';
    const afterDelete = await controller.myDeliveries(
      {} as UserProfile, undefined, '2026-11-01',
    ) as {deliveries: {id: string}[]};
    expect(afterDelete.deliveries.map(d => d.id)).to.eql(['new']);

    reassignOnLock = true;
    await expect(controller.startDelivery({} as UserProfile, 'old', {
      status: DeliveryStatus.OUT_FOR_DELIVERY,
    })).to.be.rejectedWith(/not assigned to you/);
    expect(startedOrders).to.eql(['order-2']);
  });

  for (const reassignOnLock of [false, true]) it(
    `locks the order before marking arrival (${reassignOnLock ? 'reassigned' : 'current'})`,
    async () => {
      const delivery = {id: 'run-1', riderId: 'rider-1', status: DeliveryStatus.ASSIGNED};
      const stop = {id: 'stop-1', deliveryId: 'run-1', orderId: 'order-1',
        status: DeliveryOrderStatus.PENDING};
      let committed = false;
      let rolledBack = false;
      let updated = false;
      let locked = false;
      const tx = {commit: async () => {committed = true;},
        rollback: async () => {rolledBack = true;}};
      const controller = Object.assign(Object.create(RiderDeliveryController.prototype), {
        resolveActiveRider: async () => ({id: 'rider-1'}),
        deliveryRepository: {findOne: async () => ({...delivery})},
        deliveryOrderRepository: {
          findOne: async () => ({...stop}),
          updateById: async (_id: string, _data: unknown, options: {transaction: unknown}) => {
            updated = true;
            expect(options.transaction).to.equal(tx);
          },
        },
        currentStopIds: async () => new Set([stop.id]),
        dataSource: {beginTransaction: async () => tx,
          execute: async (sql: string) => {
            expect(sql.includes('public.orders')).to.equal(true);
            locked = true;
            if (reassignOnLock) delivery.riderId = 'rider-2';
            return [];
          }},
      }) as RiderDeliveryController;

      const action = controller.markOrderArrived({} as UserProfile, 'run-1', 'order-1',
        {status: DeliveryOrderStatus.ARRIVED});
      if (reassignOnLock) {
        await expect(action).to.be.rejectedWith(/not assigned to you/);
      } else {
        await action;
      }
      expect(locked).to.equal(true);
      expect(updated).to.equal(!reassignOnLock);
      expect(committed).to.equal(!reassignOnLock);
      expect(rolledBack).to.equal(reassignOnLock);
    },
  );
});
