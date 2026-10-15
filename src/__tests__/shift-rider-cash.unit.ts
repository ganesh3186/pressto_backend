import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ShiftController} from '../controllers/shift.controller';
import {OrderStatus} from '../models/order-status.enum';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';

describe('shift collections from riders', () => {
  it('counts store-confirmed handovers in the shift when the cash reaches the till', async () => {
    const openedAt = new Date('2026-10-01T09:00:00Z');
    const closedAt = new Date('2026-10-01T17:00:00Z');
    let handoverFilter: Record<string, unknown> | undefined;
    let paymentFilter: Record<string, unknown> | undefined;
    let summaryFilter: Record<string, unknown> | undefined;
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      shiftRepository: {
        findById: async () => ({storeId: 'store-a', openedAt, closedAt}),
      },
      resolveCallerStore: async () => ({storeId: 'store-a'}),
      orderRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          if (where.createdAt) {
            summaryFilter = where;
            return [{id: 'order-a', totalAmount: 80.5}];
          }
          return [{id: 'order-a', status: 'confirmed'}];
        },
      },
      orderItemRepository: {
        find: async () => [
          {
            orderId: 'order-a',
            quantity: 2,
            additionalServiceIds: ['extra-a'],
            pendingUnitAdditionalServices: [[{serviceId: 'extra-a'}], []],
          },
          {orderId: 'order-a', quantity: 3, additionalServiceIds: ['extra-a', 'extra-b']},
        ],
      },
      paymentTransactionRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          paymentFilter = where;
          return [
            {paymentMode: 'cash', amount: 50, transactionType: 'payment'},
          ];
        },
      },
      riderCashHandoverRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          handoverFilter = where;
          return [{totalAmount: 100.5}, {totalAmount: 20}];
        },
      },
      walletRechargeRequestRepository: {
        find: async () => [{paymentMode: 'cash', amount: 25}],
      },
      pettyCashService: {computeWindowActivity: async () => ({})},
      resolveRevenue: async () => ({}),
      resolveSalesReturn: async () => ({}),
    }) as ShiftController;

    const result = (await controller.collected(
      {} as UserProfile,
      'shift-a',
    )) as {
      collections: {cash: number};
      cashReceived: number;
      orderSummary: {
        orders: number;
        items: number;
        services: number;
        value: number;
        discount: number;
      };
    };

    expect(handoverFilter).to.deepEqual({
      handoverToStoreId: 'store-a',
      status: RiderCashHandoverStatus.CONFIRMED,
      confirmedAt: {between: [openedAt, closedAt]},
      isDeleted: false,
    });
    expect(paymentFilter).to.deepEqual({
      orderId: {inq: ['order-a']},
      riderId: null,
      paymentDate: {between: [openedAt, closedAt]},
    });
    expect(result.collections.cash).to.equal(170.5);
    expect(result.cashReceived).to.equal(195.5);
    expect(summaryFilter).to.deepEqual({
      storeId: 'store-a',
      status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED]},
      createdAt: {between: [openedAt, closedAt]},
    });
    expect(result.orderSummary).to.deepEqual({
      orders: 1,
      items: 5,
      services: 12,
      value: 80.5,
      discount: 0,
    });
  });
});

describe('shift order summary', () => {
  it('drops a cancelled ticket, its items, services, value and discount', async () => {
    const orders = [
      {id: 'active', status: OrderStatus.CONFIRMED, totalAmount: 80.5, discountAmount: 10},
      {id: 'cancelled', status: OrderStatus.CANCELLED, totalAmount: 50, discountAmount: 5},
    ];
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      orderRepository: {
        find: async () => orders.filter(order => order.status !== OrderStatus.CANCELLED),
      },
      orderItemRepository: {
        find: async () => [
          {orderId: 'active', quantity: 2, additionalServiceIds: ['extra-a']},
          {orderId: 'cancelled', quantity: 3, additionalServiceIds: ['extra-a']},
        ],
      },
    }) as ShiftController;

    const summary = () => (
      controller as unknown as {
        resolveOrderSummary: (storeId: string, from: Date, to: Date) => Promise<object>;
      }
    ).resolveOrderSummary('store-a', new Date('2026-10-01'), new Date('2026-10-02'));

    const result = await summary();
    expect(result).to.deepEqual({orders: 1, items: 2, services: 4, value: 80.5, discount: 10});

    orders[0].status = OrderStatus.CANCELLED;
    const afterCancellation = await summary();
    expect(afterCancellation).to.deepEqual({
      orders: 0,
      items: 0,
      services: 0,
      value: 0,
      discount: 0,
    });
  });
});
