import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {OrderController} from '../controllers/order.controller';

describe('Delivery Management detail', () => {
  it('returns ticket details and existing images in one response', async () => {
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => undefined},
      orderRepository: {
        findOne: async () => ({
          id: 'order-1',
          orderNumber: 'ST018-1026-0191',
          customerId: 'customer-1',
          status: 'delivered',
          orderType: 'store_dropoff',
          deliveryType: 'standard',
          deliveryDate: new Date('2026-10-11T00:00:00.000Z'),
          totalAmount: 1186,
          specialInstructionMediaIds: [
            'remark-2',
            'missing',
            'document-1',
            'remark-1',
          ],
        }),
      },
      orderHandoverRepository: {
        findOne: async () => ({photoMediaId: 'proof-1'}),
      },
      customerRepository: {
        findOne: async () => ({firstName: 'Pranisha', lastName: 'Shingan'}),
      },
      statusHistoryRepository: {
        findOne: async () => ({
          changedAt: new Date('2026-10-09T06:31:00.000Z'),
          remarks: 'Delivered to reception',
        }),
      },
      paymentTransactionRepository: {
        find: async () => [{paymentMode: 'cash', transactionType: 'payment'}],
      },
      orderService: {
        computeBalanceDue: async () => ({alreadyPaid: 1186, due: 0}),
      },
      mediaRepository: {
        find: async () => [
          {id: 'remark-1', fileUrl: '/files/one.jpg', fileType: 'image/jpeg'},
          {id: 'remark-2', fileUrl: '/files/two.png', fileType: 'image/png'},
          {
            id: 'document-1',
            fileUrl: '/files/note.pdf',
            fileType: 'application/pdf',
          },
          {id: 'proof-1', fileUrl: '/files/proof.jpg', fileType: 'image/jpeg'},
        ],
      },
    }) as OrderController;

    const result = (await controller.deliveryManagementDetail(
      'order-1',
      {} as UserProfile,
    )) as {
      orderId: string;
      ticketNumber: string;
      customerName: string;
      deliveryType: string;
      actualDeliveryAt: Date;
      collectedAmount: number;
      paymentMode: string;
      remarkImages: object[];
      proofImage: object | null;
    };

    expect(result.orderId).to.equal('order-1');
    expect(result.ticketNumber).to.equal('ST018-1026-0191');
    expect(result.customerName).to.equal('Pranisha Shingan');
    expect(result.deliveryType).to.equal('store_pickup');
    expect(result.actualDeliveryAt).to.deepEqual(
      new Date('2026-10-09T06:31:00.000Z'),
    );
    expect(result.collectedAmount).to.equal(1186);
    expect(result.paymentMode).to.equal('cash');
    expect(result.remarkImages).to.deepEqual([
      {id: 'remark-2', fileUrl: '/files/two.png'},
      {id: 'remark-1', fileUrl: '/files/one.jpg'},
    ]);
    expect(result.proofImage).to.deepEqual({
      id: 'proof-1',
      fileUrl: '/files/proof.jpg',
    });
  });

  it('returns empty image fields when a ticket has no stored photos', async () => {
    const controller = Object.assign(Object.create(OrderController.prototype), {
      storeScopeService: {assertOrderVisible: async () => undefined},
      orderRepository: {
        findOne: async () => ({
          id: 'order-2',
          orderNumber: 'ST018-1026-0186',
          customerId: 'customer-2',
          orderType: 'home_pickup_home_delivery',
          totalAmount: 461,
        }),
      },
      customerRepository: {findOne: async () => null},
      statusHistoryRepository: {findOne: async () => null},
      paymentTransactionRepository: {find: async () => []},
      orderHandoverRepository: {findOne: async () => null},
      orderService: {
        computeBalanceDue: async () => ({alreadyPaid: 0, due: 461}),
      },
      mediaRepository: {
        find: async () => {
          throw new Error('No media query expected');
        },
      },
    }) as OrderController;

    const result = (await controller.deliveryManagementDetail(
      'order-2',
      {} as UserProfile,
    )) as Record<string, unknown>;

    expect(result.deliveryType).to.equal('home_delivery');
    expect(result.customerName).to.equal(null);
    expect(result.actualDeliveryAt).to.equal(null);
    expect(result.paymentStatus).to.equal('pending');
    expect(result.remarkImages).to.deepEqual([]);
    expect(result.proofImage).to.equal(null);
  });
});
