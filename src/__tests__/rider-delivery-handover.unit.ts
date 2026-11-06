import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {RiderDeliveryController} from '../controllers/rider-delivery.controller';
import {DeliveryHandoverStatus} from '../models/delivery-handover-status.enum';
import {DeliveryOrderStatus} from '../models/delivery-order-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {RiderCashHandoverTargetType} from '../models/rider-cash-handover-target-type.enum';
import {RiderType} from '../models/rider-type.enum';

describe('rider delivery handover', () => {
  it('lists only cash transactions for delivered orders', async () => {
    let orderFilter: {where: object} | undefined;
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({id: 'sender'}),
        paymentTransactionRepository: {
          find: async () => [
            {id: 'cash-delivered', orderId: 'delivered-order', amount: 20},
            {id: 'cash-in-progress', orderId: 'in-progress-order', amount: 30},
          ],
        },
        orderRepository: {
          find: async (filter: {where: object}) => {
            orderFilter = filter;
            return [{id: 'delivered-order', status: OrderStatus.DELIVERED}];
          },
        },
        storeRepository: {find: async () => []},
      },
    ) as RiderDeliveryController;

    const result = (await controller.pendingCashItems({} as UserProfile)) as {
      items: {id: string; orderId: string}[];
    };

    expect(orderFilter?.where).to.deepEqual({
      id: {inq: ['delivered-order', 'in-progress-order']},
      isDeleted: false,
      status: {inq: [OrderStatus.DELIVERED, OrderStatus.RETURNED]},
    });
    expect(result.items.map(item => item.id)).to.deepEqual(['cash-delivered']);
  });

  it('keeps cash eligible after a delivered order is fully returned', async () => {
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({id: 'sender'}),
        paymentTransactionRepository: {
          find: async () => [
            {id: 'returned-order-cash', orderId: 'returned-order', amount: 20},
          ],
        },
        orderRepository: {
          find: async () => [
            {id: 'returned-order', status: OrderStatus.RETURNED},
          ],
        },
        orderStatusHistoryRepository: {
          find: async () => [
            {orderId: 'returned-order', status: OrderStatus.DELIVERED},
          ],
        },
        storeRepository: {find: async () => []},
      },
    ) as RiderDeliveryController;

    const result = (await controller.pendingCashItems({} as UserProfile)) as {
      items: {id: string; orderId: string}[];
    };

    expect(result.items.map(item => item.id)).to.deepEqual([
      'returned-order-cash',
    ]);
  });

  it('rejects cash handover submissions containing non-delivered orders', async () => {
    let orderFilter: {where: object} | undefined;
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({
          id: 'sender',
          firstName: 'Sam',
          lastName: 'Rider',
          riderCode: 'RID-1',
        }),
        paymentTransactionRepository: {
          find: async () => [
            {
              id: 'cash-in-progress',
              orderId: 'in-progress-order',
              riderId: 'sender',
              riderHandoverStatus: 'with_rider',
              amount: 30,
            },
          ],
        },
        riderRepository: {
          findOne: async () => ({
            id: 'recipient',
            firstName: 'Van',
            lastName: 'Rider',
            isActive: true,
          }),
        },
        orderRepository: {
          find: async (filter: {where: object}) => {
            orderFilter = filter;
            return [];
          },
        },
      },
    ) as RiderDeliveryController;

    await expect(
      controller.submitHandover({} as UserProfile, {
        paymentTransactionIds: ['cash-in-progress'],
        handoverToType: RiderCashHandoverTargetType.RIDER,
        handoverToRiderId: 'recipient',
      }),
    ).to.be.rejectedWith(/only be handed over for delivered orders/);
    expect(orderFilter?.where).to.deepEqual({
      id: {inq: ['in-progress-order']},
      isDeleted: false,
      status: {inq: [OrderStatus.DELIVERED, OrderStatus.RETURNED]},
    });
  });

  it('allows cash submission when a returned order has delivered history', async () => {
    let committed = false;
    let createdItems = 0;
    const tx = {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {},
    };
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({
          id: 'sender',
          firstName: 'Sam',
          lastName: 'Rider',
          riderCode: 'RID-1',
        }),
        paymentTransactionRepository: {
          find: async () => [
            {
              id: 'cash-returned',
              orderId: 'returned-order',
              riderId: 'sender',
              riderHandoverStatus: 'with_rider',
              amount: 30,
            },
          ],
          updateById: async () => undefined,
        },
        riderRepository: {
          findOne: async () => ({
            id: 'recipient',
            firstName: 'Van',
            lastName: 'Rider',
            isActive: true,
          }),
        },
        orderRepository: {
          find: async () => [
            {
              id: 'returned-order',
              orderNumber: 'ORD-1',
              customerId: 'customer',
              status: OrderStatus.RETURNED,
            },
          ],
        },
        orderStatusHistoryRepository: {
          find: async () => [
            {orderId: 'returned-order', status: OrderStatus.DELIVERED},
          ],
        },
        customerRepository: {
          find: async () => [
            {id: 'customer', firstName: 'Casey', lastName: 'Customer'},
          ],
        },
        riderCashHandoverRepository: {
          count: async () => ({count: 0}),
          findOne: async () => null,
          create: async (handover: object) => handover,
        },
        riderCashHandoverItemRepository: {
          create: async () => {
            createdItems++;
          },
        },
        dataSource: {
          beginTransaction: async () => tx,
        },
      },
    ) as RiderDeliveryController;

    await controller.submitHandover(
      {[securityId]: 'sender-user'} as UserProfile,
      {
        paymentTransactionIds: ['cash-returned'],
        handoverToType: RiderCashHandoverTargetType.RIDER,
        handoverToRiderId: 'recipient',
      },
    );

    expect(committed).to.equal(true);
    expect(createdItems).to.equal(1);
  });

  it('lists active riders except the calling rider and supports rider-type filtering', async () => {
    let riderFilter: object | undefined;
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({id: 'sender'}),
        riderRepository: {
          find: async (filter: {where: object}) => {
            riderFilter = filter.where;
            return [
              {
                id: 'target',
                riderCode: 'VAN-1',
                firstName: 'Van',
                lastName: 'Rider',
                riderType: RiderType.VAN_RIDER,
              },
            ];
          },
        },
      },
    ) as RiderDeliveryController;

    const result = (await controller.handoverRiders(
      {} as UserProfile,
      RiderType.VAN_RIDER,
    )) as {riders: {id: string; riderType: RiderType; name: string}[]};

    expect(riderFilter).to.deepEqual({
      id: {neq: 'sender'},
      isActive: true,
      isDeleted: false,
      riderType: RiderType.VAN_RIDER,
    });
    expect(result.riders).to.deepEqual([
      {
        id: 'target',
        riderCode: 'VAN-1',
        name: 'Van Rider',
        riderType: RiderType.VAN_RIDER,
      },
    ]);
  });

  it('reserves selected pending stops until the recipient accepts or sender cancels', async () => {
    let savedHandover: Record<string, unknown> | undefined;
    let savedItem: Record<string, unknown> | undefined;
    let updatedStatus = '';
    let committed = false;
    const tx = {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {},
    };
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({
          id: 'sender',
          firstName: 'Sam',
          lastName: 'Rider',
        }),
        riderRepository: {
          findOne: async () => ({
            id: 'recipient',
            firstName: 'Van',
            lastName: 'Rider',
            isActive: true,
          }),
        },
        deliveryRepository: {
          findOne: async () => ({
            id: 'delivery-1',
            riderId: 'sender',
            status: DeliveryStatus.ASSIGNED,
          }),
        },
        deliveryOrderRepository: {
          find: async () => [
            {
              id: 'stop-1',
              deliveryId: 'delivery-1',
              orderId: 'order-1',
              orderNumber: 'ORD-1',
              customerName: 'Customer',
              status: DeliveryOrderStatus.PENDING,
            },
          ],
          updateById: async (_id: string, value: {status: string}) => {
            updatedStatus = value.status;
          },
        },
        currentStopIds: async () => new Set(['stop-1']),
        orderRepository: {
          find: async () => [
            {
              id: 'order-1',
              orderNumber: 'ORD-1',
              status: OrderStatus.READY,
            },
          ],
        },
        deliveryHandoverRepository: {
          create: async (value: Record<string, unknown>) => {
            savedHandover = value;
            return value;
          },
        },
        deliveryHandoverItemRepository: {
          create: async (value: Record<string, unknown>) => {
            savedItem = value;
            return value;
          },
        },
        dataSource: {
          beginTransaction: async () => tx,
          execute: async () => undefined,
        },
      },
    ) as RiderDeliveryController;

    await controller.submitDeliveryHandover({} as UserProfile, {
      deliveryId: 'delivery-1',
      orderIds: ['order-1'],
      handoverToRiderId: 'recipient',
    });

    expect(committed).to.equal(true);
    expect(savedHandover?.status).to.equal(DeliveryHandoverStatus.PENDING);
    expect(savedHandover?.handoverToRiderId).to.equal('recipient');
    expect(savedItem?.previousStopStatus).to.equal(DeliveryOrderStatus.PENDING);
    expect(updatedStatus).to.equal(DeliveryOrderStatus.HANDOVER_PENDING);
  });

  it('accepts a pending handover into a new run and completes the emptied source run', async () => {
    let createdDelivery: Record<string, unknown> | undefined;
    let movedStop: {deliveryId: string; status: string} | undefined;
    let orderRiderId = '';
    let handoverStatus = '';
    let sourceStatus = '';
    let committed = false;
    const tx = {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {},
    };
    const item = {
      deliveryOrderId: 'stop-1',
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      customerName: 'Customer',
    };
    const sourceDelivery = {
      id: 'delivery-1',
      riderId: 'sender',
      storeId: 'store-1',
      status: DeliveryStatus.ASSIGNED,
      deliveryDate: new Date('2026-11-06T00:00:00Z'),
      deliverySlot: 'Morning',
    };
    const controller = Object.assign(
      Object.create(RiderDeliveryController.prototype),
      {
        resolveActiveRider: async () => ({
          id: 'recipient',
          userId: 'recipient-user',
          firstName: 'Van',
          lastName: 'Rider',
        }),
        deliveryHandoverRepository: {
          findOne: async () => ({
            id: 'handover-1',
            deliveryId: 'delivery-1',
            riderId: 'sender',
            handoverToRiderId: 'recipient',
            status: DeliveryHandoverStatus.PENDING,
            submittedBy: 'sender-user',
          }),
          updateById: async (_id: string, value: {status: string}) => {
            handoverStatus = value.status;
          },
        },
        deliveryHandoverItemRepository: {find: async () => [item]},
        deliveryRepository: {
          findOne: async (filter: {where: {id: string}}) =>
            filter.where.id === 'delivery-1' ? sourceDelivery : null,
          create: async (value: Record<string, unknown>) => {
            createdDelivery = value;
            return value;
          },
          updateById: async (_id: string, value: {status?: string}) => {
            sourceStatus = value.status ?? '';
          },
        },
        deliveryOrderRepository: {
          findById: async () => ({
            id: 'stop-1',
            deliveryId: 'delivery-1',
            orderId: 'order-1',
            status: DeliveryOrderStatus.HANDOVER_PENDING,
          }),
          find: async () => [
            {
              id: 'stop-1',
              deliveryId: 'delivery-1',
              orderId: 'order-1',
              status: DeliveryOrderStatus.HANDOVER_PENDING,
            },
          ],
          updateById: async (
            _id: string,
            value: {deliveryId: string; status: string},
          ) => {
            movedStop = value;
          },
        },
        currentStopIds: async () => new Set(['stop-1']),
        orderRepository: {
          find: async () => [
            {
              id: 'order-1',
              assignedRiderId: 'sender',
              status: OrderStatus.READY,
            },
          ],
          updateById: async (_id: string, value: {assignedRiderId: string}) => {
            orderRiderId = value.assignedRiderId;
          },
        },
        riderRepository: {
          findOne: async () => ({id: 'recipient', isActive: true}),
        },
        storeRepository: {findOne: async () => ({id: 'store-1', code: 'ST01'})},
        custodyEventRepository: {create: async () => undefined},
        dataSource: {
          beginTransaction: async () => tx,
          execute: async () => undefined,
        },
      },
    ) as RiderDeliveryController;

    const result = (await controller.confirmDeliveryHandover(
      {} as UserProfile,
      'handover-1',
    )) as {sourceDeliveryCompleted: boolean; deliveryId: string};

    expect(committed).to.equal(true);
    expect(createdDelivery?.riderId).to.equal('recipient');
    expect(createdDelivery?.status).to.equal(DeliveryStatus.ASSIGNED);
    expect(movedStop?.deliveryId).to.equal(result.deliveryId);
    expect(movedStop?.status).to.equal(DeliveryOrderStatus.PENDING);
    expect(orderRiderId).to.equal('recipient');
    expect(sourceStatus).to.equal(DeliveryStatus.COMPLETED);
    expect(handoverStatus).to.equal(DeliveryHandoverStatus.CONFIRMED);
    expect(result.sourceDeliveryCompleted).to.equal(true);
  });
});
