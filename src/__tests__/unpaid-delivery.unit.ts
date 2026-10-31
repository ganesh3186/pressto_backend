/* eslint-disable @typescript-eslint/no-explicit-any -- Partial repository and service doubles. */
import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {OrderService} from '../services/order.service';
import {RiderDeliveryController} from '../controllers/rider-delivery.controller';
import {HandoverCollectorType} from '../models/order-handover.model';
import {OrderStatus} from '../models/order-status.enum';
import {GarmentStatus} from '../models/garment-status.enum';

function counter(paid = 0) {
  const order: any = {
    id: 'order',
    customerId: 'customer',
    status: OrderStatus.READY,
    totalAmount: 1000,
  };
  let handover: any;
  const garment: any = {
    id: 'garment',
    orderItemId: 'item',
    status: GarmentStatus.READY,
  };
  const payments = paid ? [{amount: paid, transactionType: 'payment'}] : [];
  const service: OrderService = Object.assign(
    Object.create(OrderService.prototype),
    {
      orderRepo: {
        findOne: async () => order,
        updateById: async (_id: string, patch: object) =>
          Object.assign(order, patch),
      },
      customerRepo: {
        findOne: async () => ({firstName: 'Test', lastName: 'Customer'}),
      },
      orderItemRepo: {find: async () => [{id: 'item', orderId: 'order'}]},
      garmentRepo: {
        find: async () => [garment],
        updateById: async (_id: string, patch: object) =>
          Object.assign(garment, patch),
      },
      approvalRequestRepo: {findOne: async () => null},
      orderHandoverRepo: {
        findOne: async () => handover,
        create: async (row: object) => (handover = row),
      },
      statusHistoryRepo: {create: async () => undefined},
      garmentStatusHistoryRepo: {create: async () => undefined},
      paymentTransactionRepo: {find: async () => payments},
      notifyStatusChange: () => undefined,
    },
  );
  const deliver = () =>
    service.handoverInStore({
      orderId: 'order',
      handedOverBy: 'staff',
      collectorType: HandoverCollectorType.SELF,
    });
  return {service, deliver, order, garment, payments};
}

function rider() {
  let paymentCalls = 0;
  let delivered = false;
  let closed = false;
  const bodyPayments: any[] = [];
  const controller: RiderDeliveryController = Object.assign(
    Object.create(RiderDeliveryController.prototype),
    {
      resolveActiveRider: async () => ({id: 'rider', userId: 'rider-user'}),
      deliveryRepository: {
        findOne: async () => ({id: 'delivery', riderId: 'rider'}),
        updateById: async () => undefined,
      },
      deliveryOrderRepository: {
        findOne: async () => ({
          id: 'stop',
          orderId: 'order',
          status: closed ? 'delivered' : 'arrived',
        }),
        find: async () => [{orderId: 'order'}],
      },
      orderRepository: {
        findOne: async () => ({
          id: 'order',
          status: OrderStatus.OUT_FOR_DELIVERY,
          totalAmount: 1000,
        }),
      },
      orderService: {
        // The fixture still owes 1000; zero or partial collection must not block delivery.
        computeBalanceDue: async () => ({due: 1000}),
        addPayment: async (_id: string, payment: any, wallet: number) => {
          paymentCalls++;
          if (payment.amount + wallet > 1000)
            throw new Error('Payment exceeds balance due');
          bodyPayments.push({amount: payment.amount, wallet});
        },
        changeStatus: async () => {
          delivered = true;
          closed = true;
        },
      },
      dataSource: {
        beginTransaction: async () => ({
          commit: async () => undefined,
          rollback: async () => undefined,
        }),
      },
      custodyEventRepository: {create: async () => undefined},
    },
  );
  const deliver = (body: any = {}) =>
    controller.deliver(
      {[securityId]: 'rider-user'} as UserProfile,
      'delivery',
      'order',
      body,
    );
  return {
    deliver,
    payments: bodyPayments,
    paymentCalls: () => paymentCalls,
    delivered: () => delivered,
  };
}

describe('delivery independent of payment', () => {
  for (const paid of [0, 250, 1000]) {
    it(
      'allows counter collection with ' +
        paid +
        ' paid and preserves outstanding balance',
      async () => {
        const test = counter(paid);
        await test.deliver();
        expect(test.order.status).to.equal(OrderStatus.DELIVERED);
        expect(test.garment.status).to.equal(GarmentStatus.DELIVERED);
        expect(test.order.totalAmount).to.equal(1000);
        expect((await test.service.computeBalanceDue(test.order)).due).to.equal(
          1000 - paid,
        );
        expect(test.payments.length).to.equal(paid ? 1 : 0);
        await expect(test.deliver()).to.be.rejected();
      },
    );
  }

  it('still rejects unfinished garments at counter handover', async () => {
    const test = counter();
    test.garment.status = GarmentStatus.IN_INSPECTION;
    await expect(test.deliver()).to.be.rejectedWith(
      /All non-returned items must be ready/,
    );
    expect(test.order.status).to.equal(OrderStatus.READY);
  });

  it('allows rider delivery without recording a payment', async () => {
    const test = rider();
    await test.deliver();
    expect(test.delivered()).to.equal(true);
    expect(test.paymentCalls()).to.equal(0);
    await expect(test.deliver()).to.be.rejectedWith(/already closed/);
  });

  it('records a partial rider collection and completes delivery', async () => {
    const test = rider();
    await test.deliver({amount: 250});
    expect(test.delivered()).to.equal(true);
    expect(test.payments).to.eql([{amount: 250, wallet: 0}]);
  });

  it('still validates supplied rider payment before delivery', async () => {
    const test = rider();
    await expect(test.deliver({amount: 1001})).to.be.rejectedWith(
      /exceeds balance due/,
    );
    expect(test.delivered()).to.equal(false);
  });
});
