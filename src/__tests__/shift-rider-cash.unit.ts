import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ShiftController} from '../controllers/shift.controller';
import {OrderStatus} from '../models/order-status.enum';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';
import {SalesReturnStatus} from '../models/sales-return.model';
import {ShiftStatus} from '../models/shift-status.enum';

describe('shift collections from riders', () => {
  it('shows requested cash refunds before approval without counting a paid payout twice', async () => {
    const from = new Date('2026-10-01T09:00:00Z');
    const to = new Date('2026-10-01T17:00:00Z');
    let approved = false;
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      salesReturnRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          expect(where).to.containEql({
            status: 'pending',
            refundMethod: 'cash',
            createdAt: {between: [from, to]},
          });
          return [
            {
              orderId: 'order-a',
              creditAmount: 20,
              status: 'pending',
              refundMethod: 'cash',
            },
          ];
        },
      },
      refundDueRepository: {
        find: async ({where}: {where: {method?: string}}) =>
          where.method
            ? approved
              ? []
              : [
                  {
                    orderId: 'order-a',
                    amount: 15,
                    approvalRequestId: 'approval-a',
                  },
                ]
            : approved
              ? []
              : [{amount: 15}],
      },
      paymentTransactionRepository: {
        find: async () => [
          {amount: 100, transactionType: 'payment'},
          {amount: 10, transactionType: 'refund'},
          ...(approved ? [{amount: 15, transactionType: 'refund'}] : []),
        ],
      },
      approvalRequestRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          expect(where).to.containEql({
            status: 'pending',
            createdAt: {between: [from, to]},
          });
          return [{id: 'approval-a'}];
        },
      },
    }) as ShiftController;
    const pending = controller['pendingCashReimbursement'].bind(controller);
    const orders = [{id: 'order-a', totalAmount: 70}] as unknown as Parameters<
      typeof pending
    >[0];

    expect(await pending(orders, ['order-a'], from, to)).to.equal(40);
    approved = true;
    expect(await pending(orders, ['order-a'], from, to)).to.equal(25);
  });

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
          {
            orderId: 'order-a',
            quantity: 3,
            additionalServiceIds: ['extra-a', 'extra-b'],
          },
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
      pendingCashReimbursement: async () => 0,
      resolveRevenue: async () => ({
        pressto: {
          revenue: 0,
          discount: 0,
          taxes: 0,
          totalSales: 0,
        },
      }),
      resolveSalesReturn: async () => ({
        pressto: {},
        revenueAdjustment: {
          revenue: 0,
          discount: 0,
          taxes: 0,
          totalSales: 0,
        },
      }),
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

describe('shift revenue after sales returns', () => {
  it('includes each store share of a rounded on-account invoice', async () => {
    const invoice = {
      id: 'invoice-a',
      orderId: 'order-a',
      isConsolidated: true,
      subtotal: 100.5,
      totalAmount: 101,
    };
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      invoiceRepository: {find: async () => [invoice]},
      invoiceOrderLinkRepository: {
        find: async () => [
          {invoiceId: invoice.id, orderId: 'order-a', orderTotal: 50.25},
          {invoiceId: invoice.id, orderId: 'order-b', orderTotal: 50.25},
        ],
      },
      orderRepository: {find: async () => [{id: 'order-a'}]},
      orderItemRepository: {find: async () => []},
    }) as ShiftController;
    const revenue = await (
      controller as unknown as {
        resolveRevenue: (
          storeId: string,
          from: Date,
          to: Date,
        ) => Promise<{
          pressto: {revenue: number; totalSales: number; tickets: number};
        }>;
      }
    ).resolveRevenue('store-a', new Date('2026-10-01'), new Date('2026-10-02'));
    expect(revenue.pressto).to.containEql({
      revenue: 50.25,
      totalSales: 50.25,
      tickets: 1,
    });
  });

  it('nets a linked on-account return once in the invoice shift and in its later shift', async () => {
    const openedAt = new Date('2026-10-01T09:00:00Z');
    const closedAt = new Date('2026-10-01T17:00:00Z');
    let invoiceDate = new Date('2026-10-01T10:00:00Z');
    const invoice = {
      id: 'invoice-a',
      orderId: 'order-a',
      isConsolidated: true,
      subtotal: 170,
      totalAmount: 170,
      createdAt: invoiceDate,
    };
    const links = [
      {invoiceId: invoice.id, orderId: 'order-a', orderTotal: 100},
      {invoiceId: invoice.id, orderId: 'order-b', orderTotal: 70},
    ];
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      invoiceRepository: {
        find: async ({where}: {where: Record<string, unknown>}) => {
          invoice.createdAt = invoiceDate;
          return where.status &&
            (invoiceDate < openedAt || invoiceDate > closedAt)
            ? []
            : [invoice];
        },
      },
      invoiceOrderLinkRepository: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.orderId
            ? links.filter(link => link.orderId === 'order-b')
            : links,
      },
      orderRepository: {
        find: async () => [
          {id: 'order-a', storeId: 'store-a'},
          {id: 'order-b', storeId: 'store-a'},
        ],
      },
      orderItemRepository: {find: async () => []},
      salesReturnRepository: {
        find: async () => [
          {
            orderId: 'order-b',
            creditAmount: 30,
            resolvedAt: new Date('2026-10-01T12:00:00Z'),
            returnedItems: [{amount: 30, originalAmount: 30}],
          },
        ],
      },
      gstConfigRepository: {
        findOne: async () => ({cgstPercentage: 9, sgstPercentage: 9}),
      },
    }) as ShiftController;
    const resolve = () =>
      (
        controller as unknown as {
          resolveNetRevenue: (
            storeId: string,
            from: Date,
            to: Date,
          ) => Promise<{
            revenue: {
              pressto: {
                revenue: number;
                totalSales: number;
                tickets: number;
                invoices: number;
              };
            };
            salesReturn: {
              pressto: {
                revenue: number;
                totalSales: number;
                tickets: number;
                invoices: number;
              };
            };
          }>;
        }
      ).resolveNetRevenue('store-a', openedAt, closedAt);

    const sameShift = await resolve();
    expect(sameShift.revenue.pressto).to.containEql({
      revenue: 170,
      totalSales: 170,
      tickets: 2,
      invoices: 1,
    });
    expect(sameShift.salesReturn.pressto).to.containEql({
      revenue: 30,
      totalSales: 30,
      tickets: 1,
      invoices: 1,
    });
    invoiceDate = new Date('2026-09-30T10:00:00Z');
    const laterShift = await resolve();
    expect(laterShift.revenue.pressto).to.containEql({
      revenue: -30,
      totalSales: -30,
    });
  });

  it('counts one invoice when two linked orders are returned in the same shift', async () => {
    const invoice = {id: 'invoice-a', isConsolidated: true};
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      salesReturnRepository: {
        find: async () =>
          ['order-a', 'order-b'].map(orderId => ({
            orderId,
            status: SalesReturnStatus.APPROVED,
            creditAmount: 10,
            resolvedAt: new Date('2026-10-01T12:00:00Z'),
            returnedItems: [{amount: 10, originalAmount: 10}],
          })),
      },
      orderRepository: {
        find: async () => [
          {id: 'order-a', storeId: 'store-a'},
          {id: 'order-b', storeId: 'store-a'},
        ],
      },
      invoiceOrderLinkRepository: {
        find: async () =>
          ['order-a', 'order-b'].map(orderId => ({
            orderId,
            invoiceId: invoice.id,
          })),
      },
      invoiceRepository: {find: async () => [invoice]},
      gstConfigRepository: {findOne: async () => null},
    }) as ShiftController;

    const result = await (
      controller as unknown as {
        resolveSalesReturn: (
          storeId: string,
          from: Date,
          to: Date,
        ) => Promise<{pressto: {tickets: number; invoices: number}}>;
      }
    ).resolveSalesReturn(
      'store-a',
      new Date('2026-10-01T09:00:00Z'),
      new Date('2026-10-01T17:00:00Z'),
    );
    expect(result.pressto).to.containEql({tickets: 2, invoices: 1});
  });

  it('deducts an older invoice return and avoids deducting a current invoice twice', async () => {
    const openedAt = new Date('2026-10-01T09:00:00Z');
    const closedAt = new Date('2026-10-01T17:00:00Z');
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      shiftRepository: {
        findById: async () => ({storeId: 'store-a', openedAt, closedAt}),
      },
      resolveCallerStore: async () => ({storeId: 'store-a'}),
      orderRepository: {
        find: async () => [
          {id: 'old-order', storeId: 'store-a', status: OrderStatus.CONFIRMED},
          {
            id: 'current-order',
            storeId: 'store-a',
            status: OrderStatus.CONFIRMED,
          },
        ],
      },
      orderItemRepository: {find: async () => []},
      paymentTransactionRepository: {find: async () => []},
      riderCashHandoverRepository: {find: async () => []},
      walletRechargeRequestRepository: {find: async () => []},
      pettyCashService: {computeWindowActivity: async () => ({})},
      pendingCashReimbursement: async () => 0,
      invoiceRepository: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.orderId
            ? [
                {
                  id: 'old-invoice',
                  orderId: 'old-order',
                  createdAt: new Date('2026-09-30T12:00:00Z'),
                },
              ]
            : [
                {
                  id: 'old-invoice',
                  orderId: 'old-order',
                  createdAt: new Date('2026-09-30T12:00:00Z'),
                },
                {
                  id: 'current-invoice',
                  orderId: 'current-order',
                  createdAt: new Date('2026-10-01T10:00:00Z'),
                },
              ],
      },
      invoiceOrderLinkRepository: {find: async () => []},
      salesReturnRepository: {
        find: async () => [
          {
            orderId: 'old-order',
            creditAmount: 118,
            resolvedAt: new Date('2026-10-01T11:00:00Z'),
            returnedItems: [{amount: 100, originalAmount: 120}],
          },
          {
            orderId: 'current-order',
            invoiceId: 'current-invoice',
            creditAmount: 118,
            resolvedAt: new Date('2026-10-01T12:00:00Z'),
            returnedItems: [{amount: 100, originalAmount: 100}],
          },
        ],
      },
      gstConfigRepository: {
        findOne: async () => ({cgstPercentage: 9, sgstPercentage: 9}),
      },
      resolveRevenue: async () => ({
        pressto: {
          revenue: 100,
          discount: 0,
          taxes: 18,
          totalSales: 118,
          tickets: 1,
          items: 1,
          services: 1,
        },
      }),
      resolveOrderSummary: async () => ({}),
    }) as ShiftController;

    const result = (await controller.collected(
      {} as UserProfile,
      'shift-a',
    )) as {
      revenue: {
        pressto: {
          revenue: number;
          discount: number;
          taxes: number;
          totalSales: number;
        };
      };
      salesReturn: {pressto: {revenue: number; totalSales: number}};
    };
    expect(result.revenue.pressto).to.containEql({
      revenue: -20,
      discount: -20,
      taxes: 0,
      totalSales: 0,
    });
    expect(result.salesReturn.pressto).to.containEql({
      revenue: 200,
      totalSales: 236,
    });
  });

  it('refreshes read-only revenue before saving the closure', async () => {
    const openedAt = new Date('2026-10-01T09:00:00Z');
    let saved: {closing: {revenue: object; salesReturn: object}} | undefined;
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      shiftRepository: {
        findById: async () => ({
          storeId: 'store-a',
          openedAt,
          status: ShiftStatus.OPEN,
        }),
        updateById: async (_id: string, record: typeof saved) => {
          saved = record;
        },
      },
      resolveCallerStore: async () => ({storeId: 'store-a'}),
      sanitizeDenominations: () => ({}),
      recalcClosingDerived: (body: object) => body,
      resolveNetRevenue: async () => ({
        revenue: {pressto: {revenue: -100}},
        salesReturn: {pressto: {revenue: 100}},
      }),
      resolveOrderSummary: async () => ({}),
    }) as ShiftController;

    await controller.close({} as UserProfile, 'shift-a', {
      remarks: 'done',
      revenue: {pressto: {revenue: 0}},
      salesReturn: {pressto: {revenue: 0}},
    } as Parameters<ShiftController['close']>[2]);
    expect(saved?.closing.revenue).to.deepEqual({pressto: {revenue: -100}});
    expect(saved?.closing.salesReturn).to.deepEqual({pressto: {revenue: 100}});
  });
});

describe('shift order summary', () => {
  it('drops a cancelled ticket, its items, services, value and discount', async () => {
    const orders = [
      {
        id: 'active',
        status: OrderStatus.CONFIRMED,
        totalAmount: 80.5,
        discountAmount: 10,
      },
      {
        id: 'cancelled',
        status: OrderStatus.CANCELLED,
        totalAmount: 50,
        discountAmount: 5,
      },
    ];
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      orderRepository: {
        find: async () =>
          orders.filter(order => order.status !== OrderStatus.CANCELLED),
      },
      orderItemRepository: {
        find: async () => [
          {orderId: 'active', quantity: 2, additionalServiceIds: ['extra-a']},
          {
            orderId: 'cancelled',
            quantity: 3,
            additionalServiceIds: ['extra-a'],
          },
        ],
      },
    }) as ShiftController;

    const summary = () =>
      (
        controller as unknown as {
          resolveOrderSummary: (
            storeId: string,
            from: Date,
            to: Date,
          ) => Promise<object>;
        }
      ).resolveOrderSummary(
        'store-a',
        new Date('2026-10-01'),
        new Date('2026-10-02'),
      );

    const result = await summary();
    expect(result).to.deepEqual({
      orders: 1,
      items: 2,
      services: 4,
      value: 80.5,
      discount: 10,
    });

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
