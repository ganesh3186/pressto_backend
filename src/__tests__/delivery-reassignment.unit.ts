import {UserProfile, securityId} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {HttpErrors} from '@loopback/rest';
import {OrderController} from '../controllers/order.controller';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderDeliveryMethod} from '../models/order-delivery-method.enum';

describe('delivery reassignment', () => {
  for (const mode of ['none', 'existing', 'unchanged', 'supplied', 'text-only',
    'different-rider', 'stale-status', 'shared-run', 'failed-shared-run', 'shared-bag',
    'shared-bag-older-owner', 'changed-address', 'saved-address',
    'raw-address', 'foreign-address', 'address-rollback',
    'out-of-scope', 'scope-changed'] as const) it(`handles ${mode} reassignment`, async () => {
    const withBag = mode === 'existing' || mode === 'supplied' ||
      mode === 'different-rider' || mode === 'shared-bag' ||
      mode === 'shared-bag-older-owner';
    const sharedRun = mode === 'shared-run' || mode === 'failed-shared-run';
    const riderId = mode === 'different-rider' ? 'rider-2' : 'rider-1';
    const date = new Date('2026-11-01T00:00:00Z');
    const runs = sharedRun ? [
      {id: 'latest', deliveryNumber: 'DL-2', status: mode === 'failed-shared-run'
        ? DeliveryStatus.OUT_FOR_DELIVERY : DeliveryStatus.ASSIGNED,
        riderId: 'rider-1', assignedAt: new Date('2026-10-31T00:00:00Z'), orderCount: 2},
    ] : [
      {id: 'older', deliveryNumber: 'DL-1', status: DeliveryStatus.ASSIGNED,
        riderId: 'rider-1', assignedAt: new Date('2026-10-30T00:00:00Z'), orderCount: 1,
        ...(mode === 'shared-bag' || mode === 'shared-bag-older-owner' ? {bagId: 'bag-1'} : {})},
      {id: 'latest', deliveryNumber: 'DL-2', status: DeliveryStatus.ASSIGNED,
        riderId: 'rider-1', assignedAt: new Date('2026-10-31T00:00:00Z'), orderCount: 1,
        ...(mode === 'unchanged' ? {deliveryDate: date,
          deliverySlot: '11 AM - 12 PM', deliverySlotId: 'slot-2'} : {}),
        ...(withBag ? {bagId: 'bag-1'} : {})},
    ];
    const updates: {id: string; status?: DeliveryStatus; deliverySlotId?: string | null;
      assignedAt?: Date}[] = [];
    const orderUpdates: {deliverySlotId?: string | null;
      deliveryAddressId?: string | null; deliveryAddress?: string}[] = [];
    const orderUpdateTransactions: unknown[] = [];
    const bagUpdates: {status?: string; currentDeliveryId?: string | null}[] = [];
    const checkedPincodes: (string | undefined)[] = [];
    const locks: string[] = [];
    let runLocked = false;
    let created = 0;
    let rolledBack = false;
    let createdDelivery: {bagId?: string} | undefined;
    const tx = {commit: async () => {}, rollback: async () => {rolledBack = true;}};
    const controller = Object.assign(Object.create(OrderController.prototype), {
      riderRepository: {findOne: async () => ({id: riderId, isActive: true,
        firstName: 'R', lastName: 'One'})},
      storeScopeService: {resolve: async () => ({global: false, storeIds: ['store-1']}),
        allows: (scope: {storeIds: string[]}, storeId: string) => scope.storeIds.includes(storeId)},
      riderAssignmentService: {resolveSlotWindow: async () => ({}),
        assertRiderRostered: async () => {},
        assertRiderCoversPincode: async (_id: string, pincode?: string) => {
          checkedPincodes.push(pincode);
          if (mode === 'changed-address' && pincode === '2222') {
            throw new HttpErrors.BadRequest('Rider does not cover the delivery pincode.');
          }
        }},
      orderRepository: {find: async (_filter: unknown, options?: {transaction?: unknown}) => [{id: 'order-1',
        status: mode === 'stale-status' && options?.transaction ? OrderStatus.RETURNED : OrderStatus.READY,
        storeId: mode === 'out-of-scope' || mode === 'scope-changed' && options?.transaction
          ? 'store-2' : 'store-1',
        customerId: 'customer-1', orderNumber: 'O-1',
        ...(mode === 'changed-address'
          ? {deliveryAddressId: options?.transaction ? 'address-new' : 'address-old'} : {}),
        assignedRiderId: 'rider-1', deliverySlotId: 'slot-1'}],
        updateById: async (_id: string, data: {deliverySlotId?: string | null;
          deliveryAddressId?: string | null; deliveryAddress?: string}, options?: {transaction?: unknown}) => {
          orderUpdates.push(data);
          orderUpdateTransactions.push(options?.transaction);
        }},
      orderService: {assertGarmentsReadyForDelivery: async () => {},
        assertGarmentsHomeForDispatch: async () => {},
        computeBalanceDue: async () => ({due: 0}),
        notifyDeliveryAssigned: () => {}},
      pickupDeliverySlotRepository: {findOne: async () => ({label: '11 AM - 12 PM'})},
      customerAddressRepository: {find: async () => [
        {id: 'address-old', pincode: '1111'}, {id: 'address-new', pincode: '2222'},
      ], findOne: async (filter: {where: {customerId: string; id: string}}) =>
        filter.where.customerId === 'customer-1' && filter.where.id === 'address-new' &&
        mode !== 'foreign-address'
          ? {id: 'address-new', customerId: 'customer-1', pincode: '2222'} : null},
      customerAddressService: {toDisplaySnapshot: () => 'New Street, 2222'},
      deliveryOrderRepository: {find: async (filter: {where: {orderId?: unknown; deliveryId?: string}}) =>
        filter.where.orderId
          ? [...(sharedRun ? [] : [{id: 'stop-1', deliveryId: 'older', orderId: 'order-1', status: 'pending'}]),
            {id: 'stop-2', deliveryId: 'latest', orderId: 'order-1',
              status: mode === 'failed-shared-run' ? 'return_to_store' : 'pending'}]
          : filter.where.deliveryId === 'latest' && sharedRun
            ? [{id: 'stop-2', deliveryId: 'latest', orderId: 'order-1',
              status: mode === 'failed-shared-run' ? 'return_to_store' : 'pending'},
              ...(runLocked && mode !== 'failed-shared-run' ? [] :
                [{id: 'stop-A', deliveryId: 'latest', orderId: 'order-A', status: 'pending'}])]
            : [{id: filter.where.deliveryId === 'latest' ? 'stop-2' : 'stop-1',
              deliveryId: filter.where.deliveryId, orderId: 'order-1', status: 'pending'}],
        create: async () => {}},
      deliveryRepository: {find: async () => runs,
        updateById: async (id: string, data: {status?: DeliveryStatus;
          deliverySlotId?: string | null; assignedAt?: Date}) => {
          updates.push({id, ...data});
          if (mode === 'address-rollback' && id === 'latest') throw new Error('simulated run failure');
        },
        findById: async () => runs.find(run => run.id === 'latest'),
        count: async () => ({count: 2}),
        create: async (data: {bagId?: string}) => {
          created++;
          createdDelivery = data;
          return {...data, id: 'new'};
        }},
      deliveryCustodyEventRepository: {create: async () => {}},
      bagRepository: {findOne: async () => ({id: 'bag-1', isActive: true}),
        findById: async () => ({id: 'bag-1', status: 'in_use',
          currentDeliveryId: mode === 'shared-bag-older-owner' ? 'older' : 'latest'}),
        updateById: async (_id: string, data: {status?: string; currentDeliveryId?: string | null}) => {
          bagUpdates.push(data);
        }},
      dataSource: {beginTransaction: async () => tx,
        execute: async (sql: string) => {
          locks.push(sql);
          if (sql.includes('public.delivery')) runLocked = true;
          return [];
        }},
      storeRepository: {findOne: async () => ({code: 'ST'})},
      customerRepository: {find: async () => []},
      notificationService: {notifyRider: async () => {}},
    }) as OrderController;
    const user = {[securityId]: 'admin-1'} as UserProfile;

    const request = {
      orderIds: ['order-1'], riderId, deliverySlot: '11 AM - 12 PM',
      ...(mode !== 'text-only' ? {deliverySlotId: 'slot-2'} : {}),
      deliveryDate: date.toISOString(),
      ...(['saved-address', 'foreign-address', 'address-rollback'].includes(mode)
        ? {deliveryAddressId: mode === 'foreign-address' ? 'address-foreign' : 'address-new'} : {}),
      ...(mode === 'raw-address' ? {deliveryAddress: '  Raw Street  '} : {}),
      ...(mode === 'supplied' ? {bagId: 'bag-1'} : {}),
    };
    if (mode === 'stale-status' || mode === 'out-of-scope' ||
        mode === 'scope-changed' || mode === 'changed-address' ||
        mode === 'foreign-address' || mode === 'address-rollback') {
      let error: {statusCode?: number} | undefined;
      try { await controller.assignDelivery(user, request); } catch (caught) {
        error = caught as {statusCode?: number};
      }
      expect(error?.statusCode).to.equal(mode === 'stale-status' ? 409 :
        mode === 'changed-address' || mode === 'foreign-address' ? 400 :
          mode === 'address-rollback' ? undefined : 404);
      expect(rolledBack).to.equal(mode !== 'out-of-scope');
      expect(orderUpdates.length).to.equal(mode === 'address-rollback' ? 1 : 0);
      if (mode === 'changed-address') expect(checkedPincodes).to.deepEqual(['2222']);
      if (mode === 'address-rollback') {
        expect(orderUpdates[0].deliveryAddressId).to.equal('address-new');
        expect(orderUpdateTransactions[0]).to.equal(tx);
      }
      return;
    }
    const result = await controller.assignDelivery(user, request) as {delivery: {id: string}};

    const newRun = mode === 'different-rider' || mode === 'failed-shared-run';
    expect(result.delivery.id).to.equal(newRun ? 'new' : 'latest');
    expect(created).to.equal(newRun ? 1 : 0);
    if (!sharedRun) expect(updates.some(update => update.id === 'older' &&
      update.status === DeliveryStatus.CANCELLED)).to.equal(true);
    if (mode === 'failed-shared-run') {
      expect(updates).to.be.empty();
    } else {
      expect(updates.some(update => update.id === 'latest' &&
        (newRun ? update.status === DeliveryStatus.CANCELLED :
          update.deliverySlotId === (mode === 'text-only' ? null : 'slot-2')))).to.equal(true);
    }
    if (mode === 'unchanged') {
      expect(updates.find(update => update.id === 'latest')?.assignedAt?.getTime())
        .to.equal(new Date('2026-10-31T00:00:00Z').getTime());
    } else if (mode === 'existing') {
      expect((updates.find(update => update.id === 'latest')?.assignedAt?.getTime() ?? 0) >
        new Date('2026-10-31T00:00:00Z').getTime()).to.equal(true);
    }
    expect(orderUpdates[0].deliverySlotId).to.equal(mode === 'text-only' ? null : 'slot-2');
    if (mode === 'saved-address') {
      expect(orderUpdates[0].deliveryAddressId).to.equal('address-new');
      expect(orderUpdates[0].deliveryAddress).to.equal('New Street, 2222');
      expect(checkedPincodes).to.deepEqual(['2222']);
    }
    if (mode === 'raw-address') {
      expect(orderUpdates[0].deliveryAddressId).to.equal(null);
      expect(orderUpdates[0].deliveryAddress).to.equal('Raw Street');
    }
    expect(locks.some(sql => sql.includes('public.bag'))).to.equal(withBag);
    expect(locks.some(sql => sql.includes('public.delivery'))).to.equal(true);
    if (mode === 'different-rider') {
      expect(bagUpdates.some(update => update.status === 'available' &&
        update.currentDeliveryId === null)).to.equal(true);
      expect(createdDelivery?.bagId).to.equal(undefined);
    }
    if (mode === 'shared-bag') expect(bagUpdates.length).to.equal(0);
    if (mode === 'shared-bag-older-owner') expect(bagUpdates).to.deepEqual([
      {status: 'in_use', currentDeliveryId: 'latest'},
    ]);
    if (sharedRun) expect(updates.some(update => update.id === 'latest' &&
      update.status === DeliveryStatus.CANCELLED)).to.equal(false);
  });

  it('does not patch an order outside the caller\'s home-store scope', async () => {
    let updated = false;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      orderRepository: {
        findOne: async () => ({id: 'order-1', storeId: 'store-2', status: OrderStatus.READY}),
        updateById: async () => {updated = true;},
      },
      storeScopeService: {
        resolve: async () => ({global: false, storeIds: ['store-1']}),
        allows: (scope: {storeIds: string[]}, storeId: string) => scope.storeIds.includes(storeId),
      },
    }) as OrderController;
    let error: {statusCode?: number} | undefined;
    try {
      await controller.updateById('order-1', {[securityId]: 'store-user'} as UserProfile,
        {deliveryAddress: 'Other street'});
    } catch (caught) {
      error = caught as {statusCode?: number};
    }
    expect(error?.statusCode).to.equal(404);
    expect(updated).to.equal(false);
  });

  it('rejects rider reassignment through order PATCH before changing the order', async () => {
    let updated = false;
    const controller = Object.assign(Object.create(OrderController.prototype), {
      orderRepository: {
        findOne: async () => ({id: 'order-1', storeId: 'store-1', status: OrderStatus.READY,
          assignedRiderId: 'rider-1'}),
        updateById: async () => {updated = true;},
      },
      storeScopeService: {
        resolve: async () => ({storeIds: ['store-1']}),
        allows: (scope: {storeIds: string[]}, storeId: string) =>
          scope.storeIds.includes(storeId),
      },
    }) as OrderController;
    let error: {statusCode?: number; message?: string} | undefined;
    try {
      await controller.updateById('order-1', {[securityId]: 'admin-1'} as UserProfile,
        {assignedRiderId: 'rider-2', deliveryMethod: OrderDeliveryMethod.HOME_DELIVERY});
    } catch (caught) {
      error = caught as {statusCode?: number; message?: string};
    }
    expect(error?.statusCode).to.equal(400);
    expect(error?.message?.includes('POST /orders/delivery-assignment')).to.equal(true);
    expect(updated).to.equal(false);
  });

  for (const mode of ['assigned-after-read', 'failed-stop', 'unassigned'] as const) {
    it(`guards ${mode} schedule edits through order PATCH`, async () => {
      let committed = false;
      let rolledBack = false;
      const tx = {commit: async () => {committed = true;},
        rollback: async () => {rolledBack = true;}};
      const locks: string[] = [];
      const updates: {deliverySlotId?: string; deliverySlot?: string}[] = [];
      const controller = Object.assign(Object.create(OrderController.prototype), {
        orderRepository: {
          findOne: async (_filter: unknown, options?: {transaction?: unknown}) => ({
            id: 'order-1', storeId: 'store-1', status: OrderStatus.READY,
            assignedRiderId: mode === 'assigned-after-read' && options?.transaction
              ? 'rider-1' : undefined,
          }),
          updateById: async (_id: string,
            data: {deliverySlotId?: string; deliverySlot?: string},
            options: {transaction?: unknown}) => {
            expect(options.transaction).to.equal(tx);
            updates.push(data);
          },
        },
        storeScopeService: {
          resolve: async () => ({storeIds: ['store-1']}),
          allows: (scope: {storeIds: string[]}, storeId: string) =>
            scope.storeIds.includes(storeId),
        },
        pickupDeliverySlotRepository: {findOne: async () => ({label: '11 AM - 12 PM'})},
        deliveryOrderRepository: {find: async () => mode === 'unassigned' ? [] : [{
          id: 'stop-1', deliveryId: 'run-1', orderId: 'order-1',
          status: mode === 'failed-stop' ? 'return_to_store' : 'pending',
        }]},
        deliveryRepository: {find: async () => [{id: 'run-1', status: DeliveryStatus.ASSIGNED}]},
        dataSource: {
          beginTransaction: async () => tx,
          execute: async (sql: string) => {locks.push(sql);},
        },
      }) as OrderController;
      let error: {statusCode?: number} | undefined;
      try {
        await controller.updateById('order-1', {[securityId]: 'admin-1'} as UserProfile,
          {deliverySlotId: 'slot-2'});
      } catch (caught) {
        error = caught as {statusCode?: number};
      }
      expect(locks.some(sql => sql.includes('public.orders'))).to.equal(true);
      if (mode === 'assigned-after-read') {
        expect(error?.statusCode).to.equal(409);
        expect(rolledBack).to.equal(true);
        expect(committed).to.equal(false);
        expect(updates).to.be.empty();
      } else {
        expect(error).to.equal(undefined);
        expect(committed).to.equal(true);
        expect(rolledBack).to.equal(false);
        expect(updates).to.deepEqual([{
          deliverySlotId: 'slot-2', deliverySlot: '11 AM - 12 PM',
        }]);
      }
    });
  }

  for (const mode of ['single', 'shared', 'failed-shared', 'started', 'order-started'] as const) {
    it(`switches ${mode} delivery to store pickup safely`, async () => {
      const tx = {commit: async () => {committed = true;},
        rollback: async () => {rolledBack = true;}};
      const run = {id: 'run-1', status: mode === 'started' || mode === 'failed-shared'
        ? DeliveryStatus.OUT_FOR_DELIVERY : DeliveryStatus.ASSIGNED,
      bagId: 'bag-1', orderCount: mode === 'shared' || mode === 'failed-shared' ? 2 : 1};
      const ownStop = {id: 'stop-1', deliveryId: run.id, orderId: 'order-1',
        status: mode === 'failed-shared' ? 'return_to_store' : 'pending'};
      const otherStop = {id: 'stop-2', deliveryId: run.id, orderId: 'order-2',
        status: 'pending'};
      const runUpdates: object[] = [];
      const orderUpdates: object[] = [];
      const bagUpdates: object[] = [];
      const deletedStops: string[] = [];
      const events: string[] = [];
      const locks: string[] = [];
      let committed = false;
      let rolledBack = false;
      const controller = Object.assign(Object.create(OrderController.prototype), {
        orderRepository: {
          findOne: async () => ({id: 'order-1', storeId: 'store-1',
            status: mode === 'order-started' ? OrderStatus.OUT_FOR_DELIVERY : OrderStatus.READY,
            deliveryDate: new Date('2026-11-01T00:00:00Z'),
            assignedRiderId: 'rider-1'}),
          updateById: async (_id: string, data: object, options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            orderUpdates.push(data);
          },
        },
        storeScopeService: {resolve: async () => ({storeIds: ['store-1']}),
          allows: (scope: {storeIds: string[]}, storeId: string) =>
            scope.storeIds.includes(storeId)},
        deliveryOrderRepository: {
          find: async (filter: {where: {orderId?: string; deliveryId?: string}}) =>
            filter.where.orderId ? [ownStop] :
              mode === 'shared' || mode === 'failed-shared' ? [ownStop, otherStop] : [ownStop],
          deleteById: async (id: string, options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            deletedStops.push(id);
          },
        },
        deliveryRepository: {
          find: async () => [run],
          updateById: async (_id: string, data: object, options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            runUpdates.push(data);
          },
        },
        bagRepository: {
          findById: async () => ({currentDeliveryId: run.id}),
          updateById: async (_id: string, data: object, options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            bagUpdates.push(data);
          },
        },
        deliveryCustodyEventRepository: {
          create: async (event: {eventType: string}, options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            events.push(event.eventType);
          },
        },
        dataSource: {
          beginTransaction: async () => tx,
          execute: async (sql: string, _ids: string[], options: {transaction: unknown}) => {
            expect(options.transaction).to.equal(tx);
            locks.push(sql);
          },
        },
      }) as OrderController;
      const user = {[securityId]: 'admin-1'} as UserProfile;
      let error: {statusCode?: number} | undefined;
      try {
        await controller.updateById('order-1', user,
          {deliveryMethod: OrderDeliveryMethod.STORE_PICKUP});
      } catch (caught) {
        error = caught as {statusCode?: number};
      }
      if (mode === 'started' || mode === 'order-started') {
        expect(error?.statusCode).to.equal(409);
        expect(rolledBack).to.equal(true);
        expect(committed).to.equal(false);
        expect(orderUpdates).to.be.empty();
        expect(runUpdates).to.be.empty();
        return;
      }
      expect(error).to.equal(undefined);
      expect(committed).to.equal(true);
      expect(rolledBack).to.equal(false);
      expect(orderUpdates).to.have.length(1);
      expect(orderUpdates[0]).to.containEql({
        deliveryMethod: OrderDeliveryMethod.STORE_PICKUP,
        assignedRiderId: null, assignedRiderName: null,
        deliverySlot: null, deliverySlotId: null,
      });
      expect(orderUpdates[0]).not.to.have.property('deliveryDate');
      expect(locks.some(sql => sql.includes('public.orders'))).to.equal(true);
      expect(locks.some(sql => sql.includes('public.delivery'))).to.equal(true);
      expect(locks.some(sql => sql.includes('public.bag'))).to.equal(true);
      if (mode === 'shared') {
        expect(deletedStops).to.deepEqual(['stop-1']);
        expect(runUpdates).to.deepEqual([{orderCount: 1}]);
        expect(bagUpdates).to.be.empty();
        expect(events).to.be.empty();
      } else if (mode === 'failed-shared') {
        expect(deletedStops).to.be.empty();
        expect(runUpdates).to.be.empty();
        expect(bagUpdates).to.be.empty();
        expect(events).to.be.empty();
      } else {
        expect(deletedStops).to.be.empty();
        expect(runUpdates[0]).to.containEql({status: DeliveryStatus.CANCELLED});
        expect(bagUpdates).to.deepEqual([{status: 'available', currentDeliveryId: null}]);
        expect(events).to.deepEqual(['cancelled', 'bag_released']);
      }
    });
  }
});
