import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {BagStatus} from '../models/bag-status.enum';
import {DeliveryCustodyEventType} from '../models/delivery-custody-event-type.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';
import {
  BagRepository,
  CustomerRepository,
  DeliveryCustodyEventRepository,
  DeliveryOrderRepository,
  DeliveryRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
  RiderCashHandoverItemRepository,
  RiderCashHandoverRepository,
  RiderRepository,
} from '../repositories';
import {OrderService, roundRupee} from '../services/order.service';

/**
 * Rider-facing delivery APIs — the counterpart to rider-pickup.controller.ts
 * for the opposite leg of the lifecycle (finished order → customer, not raw
 * items → store). Role-gated (roles: ['rider']), same posture as pickup.
 */
export class RiderDeliveryController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @repository(DeliveryRepository) private deliveryRepository: DeliveryRepository,
    @repository(DeliveryOrderRepository) private deliveryOrderRepository: DeliveryOrderRepository,
    @repository(DeliveryCustodyEventRepository)
    private custodyEventRepository: DeliveryCustodyEventRepository,
    @repository(BagRepository) private bagRepository: BagRepository,
    @repository(OrderRepository) private orderRepository: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepository: OrderItemRepository,
    @repository(CustomerRepository) private customerRepository: CustomerRepository,
    @repository(PaymentTransactionRepository)
    private paymentTransactionRepository: PaymentTransactionRepository,
    @repository(RiderCashHandoverRepository)
    private riderCashHandoverRepository: RiderCashHandoverRepository,
    @repository(RiderCashHandoverItemRepository)
    private riderCashHandoverItemRepository: RiderCashHandoverItemRepository,
    @inject('services.order') private orderService: OrderService,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  // ─── Identity ─────────────────────────────────────────────────────────────

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  // ─── The rider's own assigned deliveries ─────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/deliveries')
  @response(200, {description: "The calling rider's own deliveries"})
  async myDeliveries(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('status') status?: DeliveryStatus,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const deliveries = await this.deliveryRepository.find({
      where: {
        riderId: rider.id,
        isDeleted: false,
        ...(status
          ? {status}
          : {status: {inq: [DeliveryStatus.ASSIGNED, DeliveryStatus.OUT_FOR_DELIVERY]}}),
      } as object,
      order: ['assignedAt DESC'],
    });
    return {deliveries};
  }

  // ─── Delivery detail ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/deliveries/{id}')
  @response(200, {description: 'Delivery detail with live order data'})
  async deliveryDetail(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const delivery = await this.deliveryRepository.findOne({where: {id, isDeleted: false}});
    if (!delivery) throw new HttpErrors.NotFound('Delivery not found.');
    if (delivery.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This delivery is not assigned to you.');
    }

    const deliveryOrders = await this.deliveryOrderRepository.find({where: {deliveryId: id} as object});
    const orderIds = deliveryOrders.map(o => o.orderId);
    const orders = orderIds.length
      ? await this.orderRepository.find({where: {id: {inq: orderIds}} as object})
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    const orderItems = orderIds.length
      ? await this.orderItemRepository.find({
          where: {orderId: {inq: orderIds}} as object,
          fields: {orderId: true, quantity: true} as object,
        })
      : [];
    const itemCountByOrder = new Map<string, number>();
    for (const oi of orderItems) {
      itemCountByOrder.set(oi.orderId, (itemCountByOrder.get(oi.orderId) ?? 0) + (Number(oi.quantity) || 0));
    }

    const enrichedOrders = await Promise.all(
      deliveryOrders.map(async deliveryOrder => {
        const order = orderById.get(deliveryOrder.orderId);
        const {due} = order
          ? await this.orderService.computeBalanceDue(order)
          : {due: 0};
        return {
          ...deliveryOrder,
          orderStatus: order?.status ?? null,
          deliveryAddress: order?.deliveryAddress ?? null,
          itemCount: itemCountByOrder.get(deliveryOrder.orderId) ?? 0,
          balanceDue: due,
          isOnAccount: order?.isOnAccount ?? false,
        };
      }),
    );

    return {delivery, orders: enrichedOrders};
  }

  // ─── Start a delivery run ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @patch('/rider/deliveries/{id}/status')
  @response(200, {description: 'Delivery started — linked orders moved to out_for_delivery'})
  async startDelivery(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: {status: {type: 'string', enum: [DeliveryStatus.OUT_FOR_DELIVERY]}},
          },
        },
      },
    })
    body: {status: DeliveryStatus},
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const delivery = await this.deliveryRepository.findOne({where: {id, isDeleted: false}});
    if (!delivery) throw new HttpErrors.NotFound('Delivery not found.');
    if (delivery.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This delivery is not assigned to you.');
    }
    if (body.status !== DeliveryStatus.OUT_FOR_DELIVERY) {
      throw new HttpErrors.BadRequest(`Riders can only set status to ${DeliveryStatus.OUT_FOR_DELIVERY}.`);
    }
    if (delivery.status !== DeliveryStatus.ASSIGNED) {
      throw new HttpErrors.BadRequest(`Cannot start a delivery that is ${delivery.status}, not assigned.`);
    }

    const deliveryOrders = await this.deliveryOrderRepository.find({where: {deliveryId: id} as object});
    const orders = await this.orderRepository.find({
      where: {id: {inq: deliveryOrders.map(o => o.orderId)}} as object,
    });
    for (const order of orders) {
      if (order.status === OrderStatus.READY || order.status === OrderStatus.PARTIALLY_DISPATCHED) {
        await this.orderService.changeStatus(order.id, OrderStatus.OUT_FOR_DELIVERY, rider.userId, undefined);
      }
    }

    await this.deliveryRepository.updateById(id, {
      status: DeliveryStatus.OUT_FOR_DELIVERY,
      startedAt: new Date(),
      startedBy: currentUser[securityId],
    });

    const {v4} = await import('uuid');
    await this.custodyEventRepository.create({
      id: v4(),
      deliveryId: id,
      eventType: DeliveryCustodyEventType.OUT_FOR_DELIVERY,
      performedBy: currentUser[securityId],
    });

    return {message: 'Delivery started.'};
  }

  // ─── Deliver an order + collect payment ──────────────────────────────────
  // The rider app's "Handover Cash" screen's actual write path. On-account
  // orders skip payment entirely (deferred billing, matches createOrder()'s
  // guard elsewhere). Everything else must arrive paid in full — no partial
  // handover accepted at the door.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/deliveries/{id}/orders/{orderId}/deliver')
  @response(200, {description: 'Order marked delivered, payment recorded if required'})
  async deliver(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @param.path.string('orderId') orderId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              paymentMode: {type: 'string', enum: [PaymentMode.CASH, PaymentMode.WALLET]},
              amount: {type: 'number', minimum: 0},
              walletAmount: {type: 'number', minimum: 0},
              transactionReference: {type: 'string'},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      paymentMode?: PaymentMode;
      amount?: number;
      walletAmount?: number;
      transactionReference?: string;
      remarks?: string;
    },
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const delivery = await this.deliveryRepository.findOne({where: {id, isDeleted: false}});
    if (!delivery) throw new HttpErrors.NotFound('Delivery not found.');
    if (delivery.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This delivery is not assigned to you.');
    }
    const deliveryOrder = await this.deliveryOrderRepository.findOne({
      where: {deliveryId: id, orderId} as object,
    });
    if (!deliveryOrder) throw new HttpErrors.NotFound('This order is not on this delivery.');

    const order = await this.orderRepository.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status !== OrderStatus.OUT_FOR_DELIVERY) {
      throw new HttpErrors.BadRequest(
        `Cannot deliver an order that is ${order.status}, not out_for_delivery.`,
      );
    }

    if (!order.isOnAccount) {
      const {due} = await this.orderService.computeBalanceDue(order);
      const thisTotal = Number(body.amount ?? 0) + Number(body.walletAmount ?? 0);
      if (due > 0 && roundRupee(thisTotal) < due) {
        throw new HttpErrors.BadRequest(
          `Full payment of ₹${due} is required at delivery for this order.`,
        );
      }
      if (thisTotal > 0) {
        await this.orderService.addPayment(
          orderId,
          {
            paymentMode: body.paymentMode ?? PaymentMode.CASH,
            amount: Number(body.amount ?? 0),
            transactionReference: body.transactionReference,
          },
          Number(body.walletAmount ?? 0),
          rider.userId,
          false,
          rider.id,
        );
      }
    }

    await this.orderService.changeStatus(orderId, OrderStatus.DELIVERED, rider.userId, body.remarks);

    const {v4} = await import('uuid');
    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      await this.custodyEventRepository.create(
        {
          id: v4(),
          deliveryId: id,
          orderId,
          eventType: DeliveryCustodyEventType.ORDER_DELIVERED,
          remarks: body.remarks,
          performedBy: currentUser[securityId],
        },
        {transaction: tx},
      );

      const allDeliveryOrders = await this.deliveryOrderRepository.find({
        where: {deliveryId: id} as object,
      });
      const allOrders = await this.orderRepository.find({
        where: {id: {inq: allDeliveryOrders.map(o => o.orderId)}} as object,
        fields: {id: true, status: true} as object,
      });
      const remaining = allOrders.filter(
        o => o.id !== orderId && o.status !== OrderStatus.DELIVERED && o.status !== OrderStatus.RETURNED,
      );

      let completed = false;
      if (remaining.length === 0) {
        completed = true;
        await this.deliveryRepository.updateById(
          id,
          {status: DeliveryStatus.COMPLETED, completedAt: new Date(), completedBy: currentUser[securityId]},
          {transaction: tx},
        );
        await this.bagRepository.updateById(
          delivery.bagId,
          {status: BagStatus.AVAILABLE, currentDeliveryId: null as unknown as string},
          {transaction: tx},
        );
        await this.custodyEventRepository.create(
          {id: v4(), deliveryId: id, eventType: DeliveryCustodyEventType.BAG_RELEASED, performedBy: currentUser[securityId]},
          {transaction: tx},
        );
        await this.custodyEventRepository.create(
          {id: v4(), deliveryId: id, eventType: DeliveryCustodyEventType.COMPLETED, performedBy: currentUser[securityId]},
          {transaction: tx},
        );
      }

      await tx.commit();
      return {message: 'Order delivered.', deliveryCompleted: completed};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Pending cash to hand over ────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/cash-handovers/pending-items')
  @response(200, {description: "The rider's own cash collections not yet submitted for handover"})
  async pendingCashItems(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const transactions = await this.paymentTransactionRepository.find({
      where: {riderId: rider.id, riderHandoverStatus: 'with_rider'} as object,
      order: ['paymentDate DESC'],
    });
    const orderIds = [...new Set(transactions.map(t => t.orderId))];
    const orders = orderIds.length
      ? await this.orderRepository.find({where: {id: {inq: orderIds}} as object})
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    return {
      items: transactions.map(t => ({
        id: t.id,
        orderId: t.orderId,
        orderNumber: orderById.get(t.orderId)?.orderNumber ?? null,
        amount: t.amount,
        paymentDate: t.paymentDate,
      })),
    };
  }

  // ─── Submit a cash handover batch ─────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/cash-handovers')
  @response(200, {description: 'Cash handover batch submitted, awaiting store confirmation'})
  async submitHandover(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['paymentTransactionIds'],
            properties: {
              paymentTransactionIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {paymentTransactionIds: string[]; remarks?: string},
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const transactions = await this.paymentTransactionRepository.find({
      where: {id: {inq: body.paymentTransactionIds}} as object,
    });
    if (transactions.length !== body.paymentTransactionIds.length) {
      throw new HttpErrors.NotFound('One or more payment transactions were not found.');
    }
    const invalid = transactions.filter(
      t => (t as unknown as {riderId?: string}).riderId !== rider.id ||
        (t as unknown as {riderHandoverStatus?: string}).riderHandoverStatus !== 'with_rider',
    );
    if (invalid.length) {
      throw new HttpErrors.BadRequest('One or more transactions are not yours to hand over, or already submitted.');
    }

    const orderIds = [...new Set(transactions.map(t => t.orderId))];
    const orders = await this.orderRepository.find({where: {id: {inq: orderIds}} as object});
    const orderById = new Map(orders.map(o => [o.id, o]));
    const customerIds = [...new Set(orders.map(o => o.customerId))];
    const customers = customerIds.length
      ? await this.customerRepository.find({where: {id: {inq: customerIds}} as object})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));
    const totalAmount = transactions.reduce((s, t) => s + Number(t.amount), 0);

    const {v4} = await import('uuid');
    const now = new Date();
    const seq = (await this.riderCashHandoverRepository.count()).count + 1;
    const ddMM = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const handoverNumber = `CH-${rider.riderCode}-${ddMM}-${seq}`;

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const handover = await this.riderCashHandoverRepository.create(
        {
          id: v4(),
          handoverNumber,
          status: RiderCashHandoverStatus.PENDING,
          riderId: rider.id,
          riderName: `${rider.firstName} ${rider.lastName}`,
          riderCode: rider.riderCode,
          totalAmount,
          itemCount: transactions.length,
          submittedAt: now,
          submittedBy: currentUser[securityId],
          remarks: body.remarks,
        },
        {transaction: tx},
      );

      for (const t of transactions) {
        const order = orderById.get(t.orderId);
        const customer = order ? customerById.get(order.customerId) : undefined;
        await this.riderCashHandoverItemRepository.create(
          {
            id: v4(),
            riderCashHandoverId: handover.id,
            paymentTransactionId: t.id,
            orderId: t.orderId,
            orderNumber: order?.orderNumber ?? '',
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
            amount: t.amount,
          },
          {transaction: tx},
        );
        await this.paymentTransactionRepository.updateById(
          t.id,
          {riderHandoverStatus: 'submitted'} as object,
          {transaction: tx},
        );
      }

      await tx.commit();
      return {message: 'Cash handover submitted.', handover};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Handover history ─────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/cash-handovers')
  @response(200, {description: "The rider's own handover batch history"})
  async myHandovers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('status') status?: RiderCashHandoverStatus,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const handovers = await this.riderCashHandoverRepository.find({
      where: {riderId: rider.id, isDeleted: false, ...(status ? {status} : {})} as object,
      order: ['submittedAt DESC'],
    });
    const handoverIds = handovers.map(h => h.id);
    const items = handoverIds.length
      ? await this.riderCashHandoverItemRepository.find({
          where: {riderCashHandoverId: {inq: handoverIds}} as object,
        })
      : [];
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByHandover.get(item.riderCashHandoverId) ?? [];
      list.push(item);
      itemsByHandover.set(item.riderCashHandoverId, list);
    }

    return {
      handovers: handovers.map(h => ({...h, items: itemsByHandover.get(h.id) ?? []})),
    };
  }
}
