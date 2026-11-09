import {securityId, UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {DeliveryOrderStatus} from '../models/delivery-order-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {RiderDeliveryController} from '../controllers/rider-delivery.controller';

describe('rider delivery payment QR', () => {
  function setup(
    overrides: {
      deliveryRiderId?: string;
      deliveryStatus?: DeliveryStatus;
      stopStatus?: DeliveryOrderStatus;
      orderStatus?: OrderStatus;
      isOnAccount?: boolean;
      due?: number;
    } = {},
  ) {
    const paymentInputs: Array<{
      referenceId: string;
      amount: number;
      createdBy?: string;
    }> = [];
    const controller = Object.create(
      RiderDeliveryController.prototype,
    ) as RiderDeliveryController;
    Object.assign(controller, {
      resolveActiveRider: async () => ({id: 'rider-1', userId: 'rider-user'}),
      deliveryRepository: {
        findOne: async () => ({
          id: 'delivery-1',
          riderId: overrides.deliveryRiderId ?? 'rider-1',
          status: overrides.deliveryStatus ?? DeliveryStatus.OUT_FOR_DELIVERY,
        }),
      },
      deliveryOrderRepository: {
        findOne: async () => ({
          id: 'stop-1',
          deliveryId: 'delivery-1',
          orderId: 'order-1',
          customerName: 'Test Customer',
          customerMobile: '919999999999',
          status: overrides.stopStatus ?? DeliveryOrderStatus.OUT_FOR_DELIVERY,
        }),
      },
      currentStopIds: async () => new Set(['stop-1']),
      orderRepository: {
        findOne: async () => ({
          id: 'order-1',
          orderNumber: 'ORD-1',
          status: overrides.orderStatus ?? OrderStatus.OUT_FOR_DELIVERY,
          isOnAccount: overrides.isOnAccount ?? false,
        }),
      },
      orderService: {
        computeBalanceDue: async () => ({due: overrides.due ?? 450}),
      },
      razorpayService: {
        createPaymentLink: async (input: {
          referenceId: string;
          amount: number;
          createdBy?: string;
        }) => {
          paymentInputs.push(input);
          return {
            id: 'gateway-link-1',
            shortUrl: 'https://rzp.io/i/test-link',
            amount: input.amount,
            status: 'created',
            expiresAt: new Date('2026-11-07T10:00:00Z'),
          };
        },
      },
    });
    return {controller, paymentInputs};
  }

  const riderUser = {[securityId]: 'rider-user'} as UserProfile;

  it('creates a Razorpay payment link for the live due and returns a QR image', async () => {
    const {controller, paymentInputs} = setup({due: 825});

    const result = (await controller.createOrderPaymentQr(
      riderUser,
      'delivery-1',
      'order-1',
    )) as {
      gatewayPaymentLinkId: string;
      amount: number;
      paymentUrl: string;
      qrCodeDataUrl: string;
    };

    expect(paymentInputs).to.have.length(1);
    expect(paymentInputs[0]).to.containEql({
      referenceId: 'order-1',
      amount: 825,
      createdBy: 'rider-user',
    });
    expect(result.gatewayPaymentLinkId).to.equal('gateway-link-1');
    expect(result.amount).to.equal(825);
    expect(result.paymentUrl).to.equal('https://rzp.io/i/test-link');
    expect(result.qrCodeDataUrl).to.match(/^data:image\/png;base64,/);
  });

  it('rejects a delivery assigned to another rider', async () => {
    const {controller, paymentInputs} = setup({deliveryRiderId: 'rider-2'});

    await expect(
      controller.createOrderPaymentQr(riderUser, 'delivery-1', 'order-1'),
    ).to.be.rejectedWith('This delivery is not assigned to you.');
    expect(paymentInputs).to.have.length(0);
  });

  it('rejects closed or handed-over delivery stops', async () => {
    for (const stopStatus of [
      DeliveryOrderStatus.DELIVERED,
      DeliveryOrderStatus.RETURN_TO_STORE,
      DeliveryOrderStatus.HANDOVER_PENDING,
    ]) {
      const {controller, paymentInputs} = setup({stopStatus});
      await expect(
        controller.createOrderPaymentQr(riderUser, 'delivery-1', 'order-1'),
      ).to.be.rejected();
      expect(paymentInputs).to.have.length(0);
    }
  });

  it('rejects on-account orders and orders with no remaining due', async () => {
    for (const overrides of [{isOnAccount: true}, {due: 0}]) {
      const {controller, paymentInputs} = setup(overrides);
      await expect(
        controller.createOrderPaymentQr(riderUser, 'delivery-1', 'order-1'),
      ).to.be.rejected();
      expect(paymentInputs).to.have.length(0);
    }
  });
});
