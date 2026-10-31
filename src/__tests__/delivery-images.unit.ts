import {UserProfile} from '@loopback/security';
import {expect} from '@loopback/testlab';
import {OrderController} from '../controllers/order.controller';
import {OrderService} from '../services/order.service';
import {OrderStatus} from '../models/order-status.enum';

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
      deliveryOrderRepository: {find: async () => []},
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
          status: 'ready',
          orderType: 'home_pickup_home_delivery',
          totalAmount: 461,
        }),
      },
      customerRepository: {findOne: async () => null},
      statusHistoryRepository: {findOne: async () => null},
      deliveryOrderRepository: {
        find: async () => [{status: 'return_to_store', failureRemarks: 'Customer unavailable'}],
      },
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
    expect(result.currentDeliveryStatus).to.equal('return_to_store');
    expect(result.deliveryReturnRemarks).to.equal('Customer unavailable');
    expect(result.remarkImages).to.deepEqual([]);
    expect(result.proofImage).to.equal(null);
  });
});

describe('Delivery Management list', () => {
  it('includes delivery status and ticket notification flags', async () => {
    const orders = [
      {
        id: 'returned',
        status: 'ready',
        totalAmount: 0,
      },
      {
        id: 'ordinary',
        status: 'ready',
        totalAmount: 0,
      },
      {
        id: 'cheque',
        status: 'ready',
        totalAmount: 0,
      },
      {
        id: 'on-account',
        status: 'ready',
        isOnAccount: true,
        totalAmount: 0,
      },
    ];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        find: async () => orders,
        count: async () => ({count: orders.length}),
      },
      deliveryOrderRepo: {
        find: async () => [
          {orderId: 'returned', status: 'return_to_store', failureRemarks: 'Customer unavailable'},
          {orderId: 'returned', status: 'pending'},
        ],
      },
      customerRepo: {find: async () => []},
      paymentTransactionRepo: {find: async () => []},
      orderItemRepo: {find: async () => [{id: 'item-1', orderId: 'returned', quantity: 1}]},
      garmentRepo: {find: async () => [{id: 'garment-1', orderItemId: 'item-1'}]},
      invoiceRepo: {find: async () => [{orderId: 'ordinary'}]},
      invoiceOrderLinkRepo: {find: async () => [{orderId: 'on-account'}]},
      approvalRequestRepo: {
        find: async () => [
          {type: 'upgrade_service', entityType: 'garment', entityId: 'garment-1'},
          {type: 'cheque_payment', entityType: 'order', entityId: 'cheque'},
        ],
      },
      orderLabelAssignmentRepo: {find: async () => []},
    }) as OrderService;

    const result = await service.listOrders({});
    expect(result.rows).to.containDeep([
      {
        id: 'returned',
        status: 'ready',
        deliveryStatus: 'return_to_store',
        deliveryReturnRemarks: 'Customer unavailable',
        paymentStatus: 'paid',
        hasPendingCustomerApproval: true,
        canGenerateInvoice: true,
        hasInvoice: false,
      },
      {id: 'ordinary', deliveryStatus: null, deliveryReturnRemarks: null, canGenerateInvoice: false, hasInvoice: true},
      {id: 'cheque', canGenerateInvoice: false},
      {id: 'on-account', canGenerateInvoice: false, hasInvoice: true},
    ]);
  });
});

describe('Failed delivery stop', () => {
  it('sets the order ready and records return to store on the delivery stop', async () => {
    const orderWrites: object[] = [];
    const stopWrites: object[] = [];
    const historyWrites: object[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: 'out_for_delivery'}),
        findById: async () => ({id: 'order-1', status: 'ready'}),
        updateById: async (_id: string, value: object) => orderWrites.push(value),
      },
      deliveryOrderRepo: {
        find: async () => [{id: 'stop-1', orderId: 'order-1', deliveryId: 'run-1', status: 'arrived'}],
        updateById: async (_id: string, value: object) => stopWrites.push(value),
      },
      deliveryCustodyEventRepo: {create: async () => undefined},
      statusHistoryRepo: {create: async (value: object) => historyWrites.push(value)},
      dataSource: {beginTransaction: async () => ({commit: async () => undefined, rollback: async () => undefined})},
    }) as OrderService;

    const result = await service.returnDeliveryToStore({
      orderId: 'order-1',
      deliveryId: 'run-1',
      remarks: 'Customer unavailable',
      changedBy: 'rider-1',
    });

    expect(result.status).to.equal('ready');
    expect(orderWrites).to.containDeep([{status: 'ready', assignedRiderId: null, assignedRiderName: null}]);
    expect(stopWrites).to.containDeep([{
      status: 'return_to_store',
      failureRemarks: 'Customer unavailable',
    }]);
    expect(historyWrites).to.containDeep([{
      status: 'ready',
      remarks: 'Delivery attempt failed — returned to store: Customer unavailable',
    }]);
  });

  it('blocks delivery completion on a failed stop', async () => {
    const orderWrites: object[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {beginTransaction: async () => ({rollback: async () => undefined}), execute: async () => undefined},
      orderRepo: {
        findOne: async () => ({id: 'order-1', status: OrderStatus.READY}),
        updateById: async (_id: string, value: object) => orderWrites.push(value),
      },
      deliveryOrderRepo: {
        find: async () => [{id: 'stop-1', status: 'return_to_store'}],
      },
    }) as OrderService;

    let error: Error | undefined;
    try {
      await service.changeStatus('order-1', OrderStatus.DELIVERED, 'admin-1');
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).to.equal('A failed delivery stop needs a new delivery run before dispatch or completion.');
    expect(orderWrites).to.deepEqual([]);
  });
});
