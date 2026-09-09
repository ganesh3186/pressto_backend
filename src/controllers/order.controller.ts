import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {
  del,
  get,
  HttpErrors,
  param,
  patch,
  post,
  put,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {PaymentMode} from '../models/payment-mode.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {HandoverCollectorType} from '../models/order-handover.model';
import {DeliveryFailureReason} from '../models/delivery-failure-reason.enum';
import {BagStatus} from '../models/bag-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {DeliveryCustodyEventType} from '../models/delivery-custody-event-type.enum';
import {
  BagRepository,
  CustomerAddressRepository,
  CustomerRepository,
  DeliveryCustodyEventRepository,
  DeliveryOrderRepository,
  DeliveryRepository,
  OrderLabelAssignmentRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  RiderRepository,
  StoreRepository,
} from '../repositories';
import {DeliveryType} from '../models/delivery-type.enum';
import {OrderDeliveryMethod} from '../models/order-delivery-method.enum';
import {
  REPROCESS_REASON_LABELS,
  ReprocessReason,
  reprocessWindowDays,
} from '../models/reprocess-reason.enum';
import {CreateOrderInput, OrderPaymentInput, OrderService} from '../services/order.service';
import {ReprocessContactChannel, ReprocessService} from '../services/reprocess.service';
import {StoreScopeService} from '../services/store-scope.service';
import {ApprovalService} from '../services/approval.service';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {CustomerAddressService} from '../services/customer-address.service';
import {RiderAssignmentService} from '../services/rider-assignment.service';
import {PickupDeliverySlotRepository} from '../repositories/pickup-delivery-slot.repository';

const PAYMENT_ITEM_SCHEMA = {
  type: 'object' as const,
  required: ['paymentMode', 'amount'],
  properties: {
    paymentMode: {type: 'string' as const, enum: Object.values(PaymentMode)},
    amount: {type: 'number' as const, minimum: 0.01},
    transactionReference: {type: 'string' as const},
    gatewayResponse: {type: 'string' as const},
  },
};

const ADDITIONAL_CHARGE_SELECTION_SCHEMA = {
  oneOf: [
    {type: 'string' as const, format: 'uuid'},
    {
      type: 'object' as const,
      required: ['additionalChargeId', 'quantity'],
      properties: {
        additionalChargeId: {type: 'string' as const, format: 'uuid'},
        quantity: {type: 'integer' as const, minimum: 1},
      },
    },
  ],
};

const ORDER_UNIT_SCHEMA = {
  type: 'object' as const,
  properties: {
    brandId: {type: 'string' as const, format: 'uuid'},
    colorId: {type: 'string' as const, format: 'uuid'},
    length: {type: 'number' as const, minimum: 0},
    width: {type: 'number' as const, minimum: 0},
    additionalServiceIds: {
      type: 'array' as const,
      items: {type: 'string' as const, format: 'uuid'},
    },
    additionalChargeIds: {
      type: 'array' as const,
      items: ADDITIONAL_CHARGE_SELECTION_SCHEMA,
    },
    instructions: {type: 'string' as const},
    qrPrintCount: {type: 'integer' as const, minimum: 1},
    rejectedAtIntake: {type: 'boolean' as const},
    rejectionReason: {type: 'string' as const},
    rejectionRemarks: {type: 'string' as const},
  },
};

const ORDER_ITEM_SCHEMA = {
  type: 'object' as const,
  required: ['serviceId', 'itemId', 'quantity'],
  properties: {
    serviceId: {type: 'string' as const, format: 'uuid'},
    itemId: {type: 'string' as const, format: 'uuid'},
    quantity: {type: 'number' as const, minimum: 1},
    specialInstructions: {type: 'string' as const},
    specialInstructionMediaIds: {type: 'array' as const, items: {type: 'string' as const}},
    remarks: {type: 'string' as const},
    additionalChargeIds: {type: 'array' as const, items: ADDITIONAL_CHARGE_SELECTION_SCHEMA},
    additionalServiceIds: {type: 'array' as const, items: {type: 'string' as const, format: 'uuid'}, description: 'Additional services selected for this item'},
    units: {
      type: 'array' as const,
      items: ORDER_UNIT_SCHEMA,
      description: 'Per-garment inspection, additional-service and additional-charge selections.',
    },
  },
};

export class OrderController {
  constructor(
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(OrderStatusHistoryRepository)
    private statusHistoryRepository: OrderStatusHistoryRepository,
    @repository(OrderLabelAssignmentRepository)
    private orderLabelAssignmentRepository: OrderLabelAssignmentRepository,
    @inject('services.order')
    private orderService: OrderService,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @inject('services.reprocess')
    private reprocessService: ReprocessService,
    @inject('services.approval')
    private approvalService: ApprovalService,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(CustomerAddressRepository)
    private customerAddressRepository: CustomerAddressRepository,
    @inject('services.customer-address')
    private customerAddressService: CustomerAddressService,
    @repository(PickupDeliverySlotRepository)
    private pickupDeliverySlotRepository: PickupDeliverySlotRepository,
    @repository(BagRepository)
    private bagRepository: BagRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(DeliveryRepository)
    private deliveryRepository: DeliveryRepository,
    @repository(DeliveryOrderRepository)
    private deliveryOrderRepository: DeliveryOrderRepository,
    @repository(DeliveryCustodyEventRepository)
    private deliveryCustodyEventRepository: DeliveryCustodyEventRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('services.rider-assignment')
    private riderAssignmentService: RiderAssignmentService,
  ) {}

  // Cheque/PDC legs never got a PaymentTransaction (see order.service.ts's
  // pendingApprovalPayments/pendingApproval) — this is what turns each one
  // into a finance ApprovalRequest, routed to the `finance` role via the
  // existing APPROVAL_ROLE_ROUTING table.
  private async _createPendingPaymentApprovalRequest(
    orderId: string,
    leg: {amount: number; paymentMode: PaymentMode; transactionReference?: string},
    requestedBy: string,
  ) {
    return this.approvalService.createRequest({
      type: leg.paymentMode === PaymentMode.CHEQUE ? ApprovalRequestType.CHEQUE_PAYMENT : ApprovalRequestType.PDC_PAYMENT,
      entityType: 'order',
      entityId: orderId,
      requestedBy,
      metadata: {
        amount: leg.amount,
        paymentMode: leg.paymentMode,
        transactionReference: leg.transactionReference,
      },
    });
  }


  // ─── Create Order ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders')
  @response(200, {description: 'Order created'})
  async createOrder(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerId', 'storeId', 'orderType', 'items'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              storeId: {type: 'string', format: 'uuid'},
              orderType: {type: 'string', enum: Object.values(OrderType)},
              isDraft: {type: 'boolean', description: 'Set true to save the order as a draft without confirming it.'},
              deliveryType: {type: 'string', enum: Object.values(DeliveryType), description: 'Delivery speed: standard | express | lightning'},
              customerContactId: {type: 'string', format: 'uuid', description: 'Customer contact (person coming on behalf of the customer)'},
              expressMultiplier: {
                type: 'number',
                minimum: 1,
                description: 'Urgency multiplier (1 = standard, 2 = 2x faster/costlier). Drives the calculated deliveryDate.',
              },
              deliveryDate: {
                type: 'string',
                format: 'date-time',
                description:
                  'Promised delivery date. Overrides the ETA the backend derives from item ' +
                  'TATs and expressMultiplier. Omit to use that computed date.',
              },
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {type: 'array', items: {type: 'string'}},
              remarks: {type: 'string'},
              additionalChargeIds: {type: 'array', items: ADDITIONAL_CHARGE_SELECTION_SCHEMA},
              orderLabelIds: {type: 'array', items: {type: 'string', format: 'uuid'}, description: 'Order-level labels/tags'},
              items: {type: 'array', minItems: 1, items: ORDER_ITEM_SCHEMA},
              payments: {
                type: 'array',
                items: PAYMENT_ITEM_SCHEMA,
                description: 'One or more payment transactions (cash, card, UPI, etc.)',
              },
              walletAmount: {
                type: 'number',
                minimum: 0,
                description: 'Amount to deduct from customer wallet',
              },
            },
          },
        },
      },
    })
    body: CreateOrderInput,
  ): Promise<object> {
    const createdBy = currentUser[securityId];
    const result = (await this.orderService.createOrder(body, createdBy)) as {
      order: {id: string};
      pendingApprovalPayments: Array<{amount: number; paymentMode: PaymentMode; transactionReference?: string}>;
    };
    const approvalRequests = [];
    for (const leg of result.pendingApprovalPayments ?? []) {
      approvalRequests.push(
        await this._createPendingPaymentApprovalRequest(result.order.id, leg, createdBy),
      );
    }
    return {message: 'Order created successfully.', ...result, approvalRequests};
  }

  // ─── List Orders ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders')
  @response(200, {description: 'Enriched order list with customer details, payment summary and filters'})
  async listOrders(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('search') search?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.string('orderType') orderType?: string,
    @param.query.string('status') status?: string,
    @param.query.string('customerId') customerId?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
    // Narrows the caller's token scope down to one store/cluster — a
    // cluster-scoped caller filtering to a store within their cluster, or a
    // region-scoped caller filtering to a cluster/store within their region.
    // Can only shrink what the token already allows, never widen it — see
    // StoreScopeService.narrowStoreIds.
    @param.query.string('storeId') storeIdFilter?: string,
    @param.query.string('clusterId') clusterIdFilter?: string,
    // Manage Order sets this — that screen is order administration for the
    // order's own store only, not a workflow surface for a garment merely
    // visiting via transfer (that's what Inspection/Processing use this
    // same endpoint for, and they must keep seeing those). Every other
    // caller is unaffected: omitting it keeps today's additive behavior.
    @param.query.boolean('homeStoreOnly') homeStoreOnly?: boolean,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {
      storeId: storeIdFilter,
      clusterId: clusterIdFilter,
    });
    // Also surface orders reachable via an active inter-store transfer
    // grant to whichever stores this request is scoped to — additive,
    // widens the storeId filter rather than narrowing it. Skipped when the
    // caller explicitly asked for home-store-only (see homeStoreOnly above).
    const transferGrantedOrderIds =
      Array.isArray(storeIds) && !homeStoreOnly
        ? await this.storeScopeService.transferGrantedOrderIds(storeIds)
        : undefined;
    return this.orderService.listOrders({
      search,
      dateFrom,
      dateTo,
      orderType,
      status,
      // Scopes the list to one customer — POS uses this for Club & Pay and the
      // customer's recent orders. Undeclared params are dropped by LoopBack, so
      // this must be an explicit param, not part of a `filter` object.
      customerId,
      limit,
      skip,
      storeIds,
      transferGrantedOrderIds,
    });
  }

  // The customer's security deposit doubles as their on-account credit limit
  // — read-only preview of the same computation createOrder() gates on, so
  // the frontend can warn before submitting without duplicating the logic.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/on-account-credit/{customerId}')
  @response(200, {description: 'On-account credit limit/used/remaining for a customer'})
  async onAccountCreditStatus(
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    return this.orderService.computeOnAccountCreditStatus(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}')
  @response(200, {description: 'Order with items, charges, payments and status history'})
  async findById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser!);
    return this.orderService.getOrderDetails(id);
  }

  // ─── Update Order Metadata ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{id}')
  @response(200, {description: 'Order updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              deliveryDate: {type: 'string', format: 'date-time'},
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {type: 'array', items: {type: 'string'}},
              remarks: {type: 'string'},
              orderLabelIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description:
                  'Replaces the order\'s labels wholesale. Omit to leave labels ' +
                  'untouched; send [] to clear all of them.',
              },
              assignedRiderId: {
                type: 'string',
                format: 'uuid',
                description: 'Rider assigned for home delivery of this order.',
              },
              deliveryMethod: {type: 'string', enum: Object.values(OrderDeliveryMethod)},
              deliverySlot: {type: 'string'},
              deliverySlotId: {
                type: 'string',
                format: 'uuid',
                description: 'Resolved into a frozen deliverySlot text snapshot on save.',
              },
              deliveryAddressId: {
                type: 'string',
                format: 'uuid',
                description: "Resolved into a frozen deliveryAddress text snapshot on save.",
              },
              deliveryAddress: {
                type: 'string',
                description:
                  'Raw display text, for callers with no addressId to resolve. Prefer ' +
                  'deliveryAddressId when one is available — sending this alone clears ' +
                  'deliveryAddressId rather than leaving it pointing at a stale address.',
              },
            },
          },
        },
      },
    })
    body: {
      deliveryDate?: Date;
      specialInstructions?: string;
      specialInstructionMediaIds?: string[];
      remarks?: string;
      orderLabelIds?: string[];
      assignedRiderId?: string;
      deliveryMethod?: OrderDeliveryMethod;
      deliverySlot?: string;
      deliverySlotId?: string;
      deliveryAddressId?: string;
      deliveryAddress?: string;
    },
  ): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.RETURNED
    ) {
      throw new HttpErrors.BadRequest('Cannot update a delivered, cancelled, or returned order.');
    }

    const {orderLabelIds, assignedRiderId, deliveryAddressId, deliverySlotId, ...orderFields} = body;

    if (assignedRiderId !== undefined) {
      const rider = await this.riderRepository.findOne({where: {id: assignedRiderId, isDeleted: false}});
      if (!rider) throw new HttpErrors.BadRequest('Assigned rider not found.');
      if (!rider.isActive) throw new HttpErrors.BadRequest('Assigned rider is inactive.');
      Object.assign(orderFields, {
        assignedRiderId,
        assignedRiderName: `${rider.firstName} ${rider.lastName}`,
      });
    }

    if (deliveryAddressId !== undefined) {
      const address = await this.customerAddressRepository.findOne({
        where: {id: deliveryAddressId, isDeleted: false} as object,
      });
      if (!address) throw new HttpErrors.BadRequest('Delivery address not found.');
      Object.assign(orderFields, {
        deliveryAddressId,
        deliveryAddress: this.customerAddressService.toDisplaySnapshot(address),
      });
    } else if (body.deliveryAddress !== undefined) {
      // Raw text with no addressId to resolve — clear the FK rather than
      // silently leaving it pointing at whatever address it last referenced.
      Object.assign(orderFields, {deliveryAddressId: null});
    }

    if (deliverySlotId !== undefined) {
      const slot = await this.pickupDeliverySlotRepository.findOne({
        where: {id: deliverySlotId, isDeleted: false} as object,
      });
      if (!slot) throw new HttpErrors.BadRequest('Delivery slot not found.');
      Object.assign(orderFields, {deliverySlotId, deliverySlot: slot.label});
    }

    if (Object.keys(orderFields).length > 0) {
      await this.orderRepository.updateById(id, orderFields);
    }

    // Distinguish "field omitted" (leave labels alone) from "sent as []"
    // (clear every label) — an order can validly have zero labels.
    if (orderLabelIds !== undefined) {
      await this.orderLabelAssignmentRepository.deleteAll({orderId: id});
      for (const orderLabelId of orderLabelIds) {
        await this.orderLabelAssignmentRepository.create({orderId: id, orderLabelId});
      }
    }

    return {message: 'Order updated.'};
  }

  // ─── Bulk delivery assignment (Manual Assign — delivery leg) ──────────────
  // Assigns one rider + slot/date to several orders at once. Does not touch
  // order.status — dispatch stays a separate, explicit POST /orders/{id}/status
  // call, so this never invents a parallel status machine alongside the real
  // READY → OUT_FOR_DELIVERY → DELIVERED transitions.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/delivery-assignment')
  @response(200, {description: 'Orders assigned to a rider for delivery'})
  async assignDelivery(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['orderIds', 'riderId', 'deliverySlot', 'deliveryDate'],
            properties: {
              orderIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
              riderId: {type: 'string', format: 'uuid'},
              deliverySlot: {type: 'string'},
              deliverySlotId: {
                type: 'string',
                format: 'uuid',
                description: 'If given, overrides deliverySlot with this slot\'s label.',
              },
              deliveryDate: {type: 'string', format: 'date-time'},
              remarks: {type: 'string'},
              bagId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Optional. When given, also creates a Delivery (bag-custody run the rider app can see) — see DeliveryController/RiderDeliveryController. Omit to keep the plain per-order assignment behavior (e.g. Manual Assign).',
              },
            },
          },
        },
      },
    })
    body: {
      orderIds: string[];
      riderId: string;
      deliverySlot: string;
      deliverySlotId?: string;
      deliveryDate: string;
      remarks?: string;
      bagId?: string;
    },
  ): Promise<object> {
    const rider = await this.riderRepository.findOne({where: {id: body.riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    if (!rider.isActive) throw new HttpErrors.BadRequest('This rider is inactive.');
    // Roster is the only availability gate now — a rider with other active
    // pickups/deliveries is assignable without limit; only their roster for
    // this specific delivery's own scheduled window (not "right now") blocks
    // it. deliveryDate is already a precise date-time, so that's the
    // fallback instant when no deliverySlotId is given.
    const slotWindow = await this.riderAssignmentService.resolveSlotWindow(
      body.deliveryDate,
      body.deliverySlotId,
      new Date(body.deliveryDate).getTime(),
    );
    await this.riderAssignmentService.assertRiderRostered(body.riderId, slotWindow);

    const orders = await this.orderRepository.find({
      where: {id: {inq: body.orderIds}, isDeleted: false} as object,
    });
    if (orders.length !== body.orderIds.length) {
      throw new HttpErrors.NotFound('One or more orders were not found.');
    }
    const notDeliverable = orders.filter(
      o => o.status !== OrderStatus.READY && o.status !== OrderStatus.PARTIALLY_DISPATCHED,
    );
    if (notDeliverable.length) {
      throw new HttpErrors.BadRequest(
        `Order(s) with status ${notDeliverable.map(o => o.status).join(', ')} are not ready for delivery assignment.`,
      );
    }
    // Prevents accidentally batching cross-store orders into one rider run —
    // Rider has no storeId relation today, so this is the closest available check.
    const storeIds = new Set(orders.map(o => o.storeId));
    if (storeIds.size > 1) {
      throw new HttpErrors.BadRequest('All orders in one assignment must belong to the same store.');
    }
    // A garment can visit other stores for processing via interstore
    // transfer, but dispatch to the customer only happens from home —
    // block it if anything is still away.
    await this.orderService.assertGarmentsHomeForDispatch(body.orderIds);

    // Only riders mapped to an order's delivery pincode may be assigned to
    // it — Order itself has no pincode column, so resolve it via each
    // order's CustomerAddress. Orders with no resolvable pincode (no
    // deliveryAddressId, or address not found) skip the check rather than
    // being blocked by a data-quality gap unrelated to this feature.
    const addressIds = [
      ...new Set(orders.map(o => o.deliveryAddressId).filter((id): id is string => Boolean(id))),
    ];
    if (addressIds.length) {
      const addresses = await this.customerAddressRepository.find({
        where: {id: {inq: addressIds}} as object,
      });
      const pincodeByAddressId = new Map(addresses.map(a => [a.id, a.pincode]));
      for (const order of orders) {
        const pincode = order.deliveryAddressId ? pincodeByAddressId.get(order.deliveryAddressId) : undefined;
        await this.riderAssignmentService.assertRiderCoversPincode(body.riderId, pincode);
      }
    }

    let deliverySlot = body.deliverySlot;
    if (body.deliverySlotId !== undefined) {
      const slot = await this.pickupDeliverySlotRepository.findOne({
        where: {id: body.deliverySlotId, isDeleted: false} as object,
      });
      if (!slot) throw new HttpErrors.BadRequest('Delivery slot not found.');
      deliverySlot = slot.label;
    }

    // bagId is optional — Manual Assign calls this endpoint without one and
    // must keep working exactly as before (plain per-order assignment, no
    // Delivery created). Only Dispatch's newer bag-aware flow supplies it.
    let bag = null;
    if (body.bagId !== undefined) {
      bag = await this.bagRepository.findOne({where: {id: body.bagId, isDeleted: false}});
      if (!bag) throw new HttpErrors.NotFound('Bag not found.');
      if (!bag.isActive) throw new HttpErrors.BadRequest('This bag is inactive.');
      if (bag.status !== BagStatus.AVAILABLE) {
        throw new HttpErrors.Conflict(
          `Bag ${bag.bagNumber} is already ${bag.status === BagStatus.FULL ? 'full' : 'in use'}.`,
        );
      }
    }

    const {v4} = await import('uuid');
    const assignedRiderName = `${rider.firstName} ${rider.lastName}`;
    const deliveryDate = new Date(body.deliveryDate);

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      for (const order of orders) {
        await this.orderRepository.updateById(
          order.id,
          {
            deliveryMethod: OrderDeliveryMethod.HOME_DELIVERY,
            assignedRiderId: body.riderId,
            assignedRiderName,
            deliverySlot,
            ...(body.deliverySlotId !== undefined ? {deliverySlotId: body.deliverySlotId} : {}),
            deliveryDate,
            ...(body.remarks ? {remarks: body.remarks} : {}),
          },
          {transaction: tx},
        );
      }

      // A Delivery (the rider-app-visible run) is created on every
      // assignment, not just when a bag is supplied — the rider app reads
      // from this table, not Order.assignedRiderId directly, so without it
      // the rider would never see the delivery at all. bagId only adds
      // custody-bag tracking on top when one happens to be given.
      const store = await this.storeRepository.findOne({where: {id: orders[0].storeId}});
      const customers = await this.customerRepository.find({
        where: {id: {inq: [...new Set(orders.map(o => o.customerId))]}} as object,
      });
      const customerById = new Map(customers.map(c => [c.id, c]));

      const now = new Date();
      const ddMM = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const seq = (await this.deliveryRepository.count()).count + 1;
      const deliveryNumber = `DL-${store?.code ?? 'ST'}-${ddMM}-${seq}`;

      const delivery = await this.deliveryRepository.create(
        {
          id: v4(),
          deliveryNumber,
          status: DeliveryStatus.ASSIGNED,
          storeId: orders[0].storeId,
          riderId: body.riderId,
          riderName: assignedRiderName,
          ...(bag ? {bagId: bag.id} : {}),
          deliverySlot,
          deliverySlotId: body.deliverySlotId,
          deliveryDate,
          orderCount: orders.length,
          assignedAt: now,
          assignedBy: currentUser[securityId],
          remarks: body.remarks,
        },
        {transaction: tx},
      );

      for (const order of orders) {
        const customer = customerById.get(order.customerId);
        const {due} = await this.orderService.computeBalanceDue(order);
        await this.deliveryOrderRepository.create(
          {
            id: v4(),
            deliveryId: delivery.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
            balanceDueAtAssignment: due,
          },
          {transaction: tx},
        );
      }

      await this.deliveryCustodyEventRepository.create(
        {
          id: v4(),
          deliveryId: delivery.id,
          eventType: DeliveryCustodyEventType.ASSIGNED,
          performedBy: currentUser[securityId],
        },
        {transaction: tx},
      );

      if (bag) {
        // Bag capacity here is "one bag, one rider run" — unlike Transfer,
        // where maxCapacity gates individual garments, a delivery bag just
        // needs to be locked to this run; no per-garment count exists at
        // this layer to check against. FULL is never set here — only a
        // future per-garment accounting pass would have grounds to.
        await this.bagRepository.updateById(
          bag.id,
          {status: BagStatus.IN_USE, currentDeliveryId: delivery.id, currentStoreId: orders[0].storeId},
          {transaction: tx},
        );
      }

      await tx.commit();
      return {
        message: 'Orders assigned for delivery.',
        assignedCount: orders.length,
        delivery,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Change Status ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/status')
  @response(200, {description: 'Order status changed'})
  async changeStatus(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: {
              status: {type: 'string', enum: Object.values(OrderStatus)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {status: OrderStatus; remarks?: string},
  ): Promise<object> {
    const changedBy = currentUser[securityId];
    const result = await this.orderService.changeStatus(id, body.status, changedBy, body.remarks);
    const response: Record<string, unknown> = {message: `Order status changed to '${body.status}'.`};
    if ((result as any).garments?.length) {
      response.garments = (result as any).garments;
      response.note = `${(result as any).garments.length} garments auto-created. Add brand, color and inspection details to each.`;
    }
    return response;
  }

  // ─── Delivery Return (failed/undeliverable attempt) ────────────────────────
  // Distinct from OrderStatus.RETURNED — that's the sales-return/refund
  // flow, a permanent terminal state excluded from active-order queries.
  // This is the opposite: a rider couldn't complete the customer delivery
  // and brought the order back to the store, so it just reverts to READY
  // with the delivery assignment cleared, ready to be redispatched like
  // any other ready order. Always reverts to READY, never back to
  // PARTIALLY_DISPATCHED — Order.status is single-valued, so once it moved
  // to OUT_FOR_DELIVERY there's no cheap way to recover which state it came
  // from. A rare edge case (a split order whose remainder fails delivery),
  // not handled specially this pass.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/delivery-return')
  @response(200, {description: 'Delivery attempt reverted — order back to ready for redispatch'})
  async deliveryReturn(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['remarks'],
            properties: {
              remarks: {
                type: 'string',
                description: 'Why the delivery attempt failed / the order came back to the store.',
              },
              reasons: {
                type: 'array',
                description: 'Optional structured reasons, alongside remarks — see DeliveryFailureReason.',
                items: {type: 'string', enum: Object.values(DeliveryFailureReason)},
              },
              otherReason: {type: 'string', description: 'Required when reasons includes "other".'},
            },
          },
        },
      },
    })
    body: {remarks: string; reasons?: DeliveryFailureReason[]; otherReason?: string},
  ): Promise<object> {
    const updated = await this.orderService.returnDeliveryToStore({
      orderId: id,
      remarks: body.remarks,
      reasons: body.reasons,
      otherReason: body.otherReason,
      changedBy: currentUser[securityId],
    });
    return {message: 'Delivery returned to store. Order is ready for redispatch.', order: updated};
  }

  // ─── Edit Order Items ─────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @put('/orders/{id}/items')
  @response(200, {description: 'Order items replaced, totals and garments reconciled'})
  async updateOrderItems(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                description:
                  'The complete desired item list. Lines missing from it are removed, ' +
                  'so send the full cart, not a delta.',
                items: {
                  type: 'object',
                  required: ['serviceId', 'itemId', 'quantity'],
                  properties: {
                    serviceId: {type: 'string', format: 'uuid'},
                    itemId: {type: 'string', format: 'uuid'},
                    quantity: {type: 'number', minimum: 1},
                    additionalServiceIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
                    additionalChargeIds: {type: 'array', items: ADDITIONAL_CHARGE_SELECTION_SCHEMA},
                    specialInstructions: {type: 'string'},
                    specialInstructionMediaIds: {type: 'array', items: {type: 'string'}},
                    remarks: {type: 'string'},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {
      items: {
        serviceId: string;
        itemId: string;
        quantity: number;
        additionalServiceIds?: string[];
        additionalChargeIds?: Array<string | {additionalChargeId: string; quantity: number}>;
        specialInstructions?: string;
        specialInstructionMediaIds?: string[];
        remarks?: string;
      }[];
    },
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    return this.orderService.updateOrderItems(id, body.items, currentUser[securityId]);
  }

  // ─── Reprocess after delivery ─────────────────────────────────────────────

  @authenticate('jwt')
  @get('/reprocess-reasons')
  @response(200, {description: 'Reason options and the claim window, for the reprocess form'})
  async reprocessReasons(): Promise<object> {
    return {
      // Served rather than hardcoded in each panel, so admin and customer app
      // always offer the same wording and the same window.
      reasons: Object.values(ReprocessReason).map(value => ({
        value,
        label: REPROCESS_REASON_LABELS[value],
        requiresRemarks: value === ReprocessReason.OTHER,
      })),
      windowDays: reprocessWindowDays(),
    };
  }
  // Customer says a delivered item was not done properly. Raises an approval
  // request; on approval a free ₹0 rework order is created automatically.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{id}/reprocess-request')
  @response(200, {description: 'Reprocess request raised, awaiting approval'})
  async requestReprocess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {type: 'string', enum: Object.values(ReprocessReason)},
              remarks: {type: 'string', description: 'Required when reason is "other"'},
              mediaIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
              garmentIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Pieces to redo. Omit to send the whole order.',
              },
              contactChannel: {
                type: 'string',
                enum: ['in_store', 'phone', 'whatsapp', 'other'],
                description:
                  'How the customer got in touch. "in_store" (default) creates the ₹0 rework ' +
                  'order the moment this is approved, same as always. Anything else defers ' +
                  'that until a linked pickup actually brings the garment back.',
              },
            },
          },
        },
      },
    })
    body: {
      reason: ReprocessReason;
      remarks?: string;
      mediaIds?: string[];
      garmentIds?: string[];
      contactChannel?: ReprocessContactChannel;
    },
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    return this.reprocessService.raiseRequest({
      orderId: id,
      garmentIds: body.garmentIds,
      reason: body.reason,
      remarks: body.remarks,
      mediaIds: body.mediaIds,
      requestedBy: currentUser[securityId],
      source: 'store',
      contactChannel: body.contactChannel,
    });
  }

  // ─── Counter Inspection ───────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/inspection/complete')
  @response(200, {description: 'All items inspected at the counter — order moved to processing'})
  async completeCounterInspection(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    return this.orderService.completeCounterInspection(id, currentUser[securityId]);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/inspection/mark')
  @response(200, {description: 'Record which units were inspected at the counter'})
  async markUnitsInspected(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['units'],
            properties: {
              units: {
                type: 'array',
                description: 'Units inspected at the counter, identified by line and position',
                items: {
                  type: 'object',
                  required: ['serviceId', 'itemId', 'unitIndex'],
                  properties: {
                    serviceId: {type: 'string', format: 'uuid'},
                    itemId: {type: 'string', format: 'uuid'},
                    unitIndex: {type: 'number'},
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {units: {serviceId: string; itemId: string; unitIndex: number}[]},
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    return this.orderService.markUnitsInspected(id, body.units, currentUser[securityId]);
  }

  // ─── Split Order ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/split')
  @response(200, {description: 'Split ready garments into a new sub-order dispatched immediately'})
  async splitOrder(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['garmentIds'],
            properties: {
              garmentIds: {
                type: 'array',
                minItems: 1,
                items: {type: 'string', format: 'uuid'},
                description: 'IDs of garments to split out into a sub-order',
              },
              deliveryDate: {type: 'string', format: 'date-time', description: 'New delivery date for the sub-order'},
              deliveryType: {type: 'string', enum: Object.values(DeliveryType), description: 'New delivery tier for the sub-order (e.g. split an express garment out of a standard order). Re-applies the tier uplift on the sub-order pricing.'},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {garmentIds: string[]; deliveryDate?: string; deliveryType?: DeliveryType; remarks?: string},
  ): Promise<object> {
    return this.orderService.splitOrder(
      id,
      body.garmentIds,
      body.deliveryDate,
      body.deliveryType,
      body.remarks,
      currentUser[securityId],
    );
  }

  // ─── Add Payment to Existing Order ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/payments')
  @response(200, {description: 'Payment recorded against order'})
  async addPayment(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              payment: PAYMENT_ITEM_SCHEMA,
              walletAmount: {type: 'number', minimum: 0},
            },
          },
        },
      },
    })
    body: {payment?: OrderPaymentInput; walletAmount?: number},
  ): Promise<object> {
    if (!body.payment && !body.walletAmount) {
      throw new HttpErrors.BadRequest('Provide at least one of payment or walletAmount.');
    }
    const result = (await this.orderService.addPayment(
      id,
      body.payment!,
      Number(body.walletAmount ?? 0),
      currentUser[securityId],
    )) as {
      pendingApproval: {amount: number; paymentMode: PaymentMode; transactionReference?: string} | null;
    };
    const approvalRequest = result.pendingApproval
      ? await this._createPendingPaymentApprovalRequest(id, result.pendingApproval, currentUser[securityId])
      : null;
    return {...result, approvalRequest};
  }

  // ─── In-store Handover (counter pickup) ────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{id}/handover')
  @response(200, {description: 'Order handed over in store and marked delivered'})
  async handover(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['collectorType'],
            properties: {
              collectorType: {type: 'string', enum: Object.values(HandoverCollectorType)},
              // Required when collectorType = 'contact'
              customerContactId: {type: 'string', format: 'uuid'},
              // Required when collectorType = 'family_member'
              familyGroupMemberId: {type: 'string', format: 'uuid'},
              // Required when collectorType = 'other'; snapshot for the others
              collectorName: {type: 'string'},
              collectorPhone: {type: 'string'},
              collectorRelationship: {type: 'string', enum: Object.values(ContactRelationship)},
              // 'other' only: also persist the person as a reusable contact
              saveAsContact: {type: 'boolean'},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      collectorType: HandoverCollectorType;
      customerContactId?: string;
      familyGroupMemberId?: string;
      collectorName?: string;
      collectorPhone?: string;
      collectorRelationship?: ContactRelationship;
      saveAsContact?: boolean;
      remarks?: string;
    },
  ): Promise<object> {
    return this.orderService.handoverInStore({
      orderId: id,
      collectorType: body.collectorType,
      customerContactId: body.customerContactId,
      familyGroupMemberId: body.familyGroupMemberId,
      collectorName: body.collectorName,
      collectorPhone: body.collectorPhone,
      collectorRelationship: body.collectorRelationship,
      saveAsContact: body.saveAsContact,
      remarks: body.remarks,
      handedOverBy: currentUser[securityId],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}/handover')
  @response(200, {description: 'Handover record for an order (null if not handed over)'})
  async getHandover(@param.path.string('id') id: string): Promise<object> {
    const handover = await this.orderService.getHandover(id);
    return {handover};
  }

  // ─── Get Payment History ──────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}/payments')
  @response(200, {description: 'Payment transactions for an order'})
  async getPayments(@param.path.string('id') id: string): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const details = await this.orderService.getOrderDetails(id);
    const {paymentTransactions, totalCollected, balanceDue} = details as any;
    return {paymentTransactions, totalCollected, balanceDue, totalAmount: order.totalAmount};
  }

  // ─── Correct a Payment's Mode (finance) ────────────────────────────────────
  // "The cashier recorded UPI but it was actually cash" — relabels an
  // already-recorded payment. Distinct permission from order:create (which
  // records a new payment) so it can be granted to finance on its own.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['payment:update']})
  @patch('/orders/{id}/payments/{paymentId}')
  @response(200, {description: "Payment's mode corrected"})
  async correctPaymentMode(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @param.path.string('paymentId') paymentId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['paymentMode', 'reason'],
            properties: {
              paymentMode: {type: 'string', enum: Object.values(PaymentMode)},
              reason: {type: 'string', description: 'Required — why this payment is being corrected.'},
            },
          },
        },
      },
    })
    body: {paymentMode: PaymentMode; reason: string},
  ): Promise<object> {
    const userLabel = currentUser as {name?: string; email?: string};
    const performedByLabel = userLabel.name ?? userLabel.email ?? currentUser[securityId];
    const payment = await this.orderService.correctPaymentMode(
      id,
      paymentId,
      body.paymentMode,
      performedByLabel,
      body.reason,
    );
    return {message: 'Payment mode corrected.', payment};
  }

  // ─── Status History ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}/status-history')
  @response(200, {description: 'Order status change history'})
  async statusHistory(@param.path.string('id') id: string): Promise<object> {
    const history = await this.statusHistoryRepository.find({
      where: {orderId: id},
      order: ['changedAt DESC'],
    });
    return {history};
  }

  // ─── Activity Log ───────────────────────────────────────────────────────
  // Unified timeline for Order Summary — every action across the order and
  // its garments (status changes, processing, approvals, sales returns,
  // transfers, delivery, handover, the originating pickup), merged and
  // sorted. See OrderService.getActivityLog for the source-by-source detail.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}/activity-log')
  @response(200, {description: 'Unified activity log for an order and its garments'})
  async activityLog(@param.path.string('id') id: string): Promise<object> {
    return this.orderService.getActivityLog(id);
  }

  // ─── Soft Delete ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:delete']})
  @del('/orders/{id}')
  @response(200, {description: 'Order cancelled and soft-deleted'})
  async deleteById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.RETURNED) {
      throw new HttpErrors.BadRequest('Cannot delete a delivered or returned order.');
    }
    await this.orderRepository.updateById(id, {
      isDeleted: true,
      status: OrderStatus.CANCELLED,
      deletedAt: new Date() as unknown as Date,
    });
    await this.statusHistoryRepository.create({
      id: (await import('uuid')).v4(),
      orderId: id,
      status: OrderStatus.CANCELLED,
      changedAt: new Date(),
      changedBy: currentUser[securityId],
      remarks: 'Order deleted',
    });
    return {message: 'Order cancelled and deleted.'};
  }
}
