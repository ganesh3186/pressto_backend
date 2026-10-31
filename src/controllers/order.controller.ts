import {OrderExportFilters} from '../utils/order-export';
import {resolveOrderPaymentStatus} from '../utils/payment-status';
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
import {Delivery} from '../models/delivery.model';
import {DeliveryOrderStatus} from '../models/delivery-order-status.enum';
import {DeliveryCustodyEventType} from '../models/delivery-custody-event-type.enum';
import {
  BagRepository,
  CustomerAddressRepository,
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerRepository,
  DeliveryCustodyEventRepository,
  DeliveryOrderRepository,
  DeliveryRepository,
  MediaRepository,
  OrderLabelAssignmentRepository,
  OrderHandoverRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PaymentTransactionRepository,
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
import {
  CreateOrderInput,
  OrderPaymentInput,
  OrderService,
} from '../services/order.service';
import {EditOrderUnitInput} from '../services/order-item-edit-units';
import {
  ReprocessContactChannel,
  ReprocessService,
} from '../services/reprocess.service';
import {StoreScopeService} from '../services/store-scope.service';
import {ApprovalService} from '../services/approval.service';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestRepository} from '../repositories/approval-request.repository';
import {CustomerAddressService} from '../services/customer-address.service';
import {RiderAssignmentService} from '../services/rider-assignment.service';
import {
  NotificationService,
  RIDER_NOTIFICATION_TYPES,
} from '../services/notification.service';
import {SystemNotificationService} from '../services/system-notification.service';
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
    itemPhotoMediaIds: {
      type: 'array' as const,
      items: {type: 'string' as const, format: 'uuid' as const},
    },
    stainMarks: {type: 'array' as const, items: {type: 'object' as const,
      required: ['stainId'], properties: {
        stainId: {type: 'string' as const, format: 'uuid' as const},
        remarks: {type: 'string' as const},
        mediaIds: {type: 'array' as const, items: {type: 'string' as const, format: 'uuid' as const}},
      }}},
    damageMarks: {type: 'array' as const, items: {type: 'object' as const,
      required: ['damageId'], properties: {
        damageId: {type: 'string' as const, format: 'uuid' as const},
        remarks: {type: 'string' as const},
        mediaIds: {type: 'array' as const, items: {type: 'string' as const, format: 'uuid' as const}},
      }}},
    qrPrintCount: {type: 'integer' as const, minimum: 1},
    rejectedAtIntake: {type: 'boolean' as const},
    rejectionReason: {type: 'string' as const},
    rejectionRemarks: {type: 'string' as const},
  },
};

// PUT /orders/{id}/items unit: same selections as creation, plus the garment id of
// an existing piece so its own services/charges/measurements are updated.
const EDIT_ORDER_UNIT_SCHEMA = {
  ...ORDER_UNIT_SCHEMA,
  properties: {
    ...ORDER_UNIT_SCHEMA.properties,
    id: {
      type: 'string' as const,
      description:
        'Garment id of an existing piece; omit for a piece added in this edit.',
    },
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
    specialInstructionMediaIds: {
      type: 'array' as const,
      items: {type: 'string' as const},
    },
    remarks: {type: 'string' as const},
    additionalChargeIds: {
      type: 'array' as const,
      items: ADDITIONAL_CHARGE_SELECTION_SCHEMA,
    },
    additionalServiceIds: {
      type: 'array' as const,
      items: {type: 'string' as const, format: 'uuid'},
      description: 'Additional services selected for this item',
    },
    units: {
      type: 'array' as const,
      items: ORDER_UNIT_SCHEMA,
      description:
        'Per-garment inspection, additional-service and additional-charge selections.',
    },
  },
};

const EDIT_ORDER_ITEM_SCHEMA = {
  ...ORDER_ITEM_SCHEMA,
  properties: {
    ...ORDER_ITEM_SCHEMA.properties,
    units: {type: 'array' as const, items: EDIT_ORDER_UNIT_SCHEMA},
  },
};

export class OrderController {
  constructor(
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(OrderHandoverRepository)
    private orderHandoverRepository: OrderHandoverRepository,
    @repository(MediaRepository)
    private mediaRepository: MediaRepository,
    @repository(OrderStatusHistoryRepository)
    private statusHistoryRepository: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository)
    private paymentTransactionRepository: PaymentTransactionRepository,
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
    @repository(CustomerFamilyGroupRepository)
    private customerFamilyGroupRepository: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository)
    private customerFamilyGroupMemberRepository: CustomerFamilyGroupMemberRepository,
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
    @inject('services.notification')
    private notificationService: NotificationService,
    @repository(ApprovalRequestRepository)
    private approvalRequestRepo: ApprovalRequestRepository,
    @inject('services.system-notification', {optional: true})
    private systemNotificationService?: SystemNotificationService,
  ) {}

  // Cheque/PDC legs never got a PaymentTransaction (see order.service.ts's
  // pendingApprovalPayments/pendingApproval) — this is what turns each one
  // into a finance ApprovalRequest, routed to the `finance` role via the
  // existing APPROVAL_ROLE_ROUTING table.
  private async _createPendingPaymentApprovalRequest(
    orderId: string,
    leg: {
      amount: number;
      paymentMode: PaymentMode;
      transactionReference?: string;
    },
    requestedBy: string,
  ) {
    return this.approvalService.createRequest({
      type:
        leg.paymentMode === PaymentMode.CHEQUE
          ? ApprovalRequestType.CHEQUE_PAYMENT
          : ApprovalRequestType.PDC_PAYMENT,
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
              isDraft: {
                type: 'boolean',
                description:
                  'Set true to save the order as a draft without confirming it.',
              },
              draftEditorState: {type: 'object'},
              deliveryType: {
                type: 'string',
                enum: Object.values(DeliveryType),
                description: 'Delivery speed: standard | express | lightning',
              },
              customerContactId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Customer contact (person coming on behalf of the customer)',
              },
              familyGroupMemberId: {type: 'string', format: 'uuid'},
              expressMultiplier: {
                type: 'number',
                minimum: 1,
                description:
                  'Urgency multiplier (1 = standard, 2 = 2x faster/costlier). Drives the calculated deliveryDate.',
              },
              deliveryDate: {
                type: 'string',
                format: 'date-time',
                description:
                  'Promised delivery date. Overrides the ETA the backend derives from item ' +
                  'TATs and expressMultiplier. Omit to use that computed date.',
              },
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {
                type: 'array',
                items: {type: 'string'},
              },
              remarks: {type: 'string'},
              additionalChargeIds: {
                type: 'array',
                items: ADDITIONAL_CHARGE_SELECTION_SCHEMA,
              },
              orderLabelIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Order-level labels/tags',
              },
              items: {type: 'array', minItems: 1, items: ORDER_ITEM_SCHEMA},
              payments: {
                type: 'array',
                items: PAYMENT_ITEM_SCHEMA,
                description:
                  'One or more payment transactions (cash, card, UPI, etc.)',
              },
              walletAmount: {
                type: 'number',
                minimum: 0,
                description: 'Amount to deduct from customer wallet',
              },
              paymentIsOnAccount: {
                type: 'boolean',
                description:
                  'Bill this order on account when the customer is eligible.',
              },
              couponCodes: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: CreateOrderInput,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, body.storeId)) {
      throw new HttpErrors.NotFound('Store not found.');
    }
    const createdBy = currentUser[securityId];
    const result = (await this.orderService.createOrder(body, createdBy)) as {
      order: {id: string};
      pendingApprovalPayments: Array<{
        amount: number;
        paymentMode: PaymentMode;
        transactionReference?: string;
      }>;
    };
    const approvalRequests = [];
    for (const leg of result.pendingApprovalPayments ?? []) {
      approvalRequests.push(
        await this._createPendingPaymentApprovalRequest(
          result.order.id,
          leg,
          createdBy,
        ),
      );
    }

    if (result?.order?.id && this.systemNotificationService) {
      this.orderRepository
        .findById(result.order.id)
        .then(async savedOrder => {
          let customerName: string | undefined;
          try {
            const customerId = savedOrder?.customerId ?? body.customerId;
            if (customerId) {
              const cust = await this.customerRepository.findById(customerId);
              if (cust) {
                customerName = [cust.firstName, cust.lastName]
                  .filter(Boolean)
                  .join(' ')
                  .trim();
              }
            }
          } catch (_) {}
          return this.systemNotificationService!.notifyOrderCreated(
            savedOrder,
            customerName,
          );
        })
        .catch(err => {
          console.error('Failed to notify super admin for created order:', err);
        });
    }

    return {
      message: 'Order created successfully.',
      ...result,
      approvalRequests,
    };
  }

  // ─── List Orders ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders')
  @response(200, {
    description:
      'Enriched order list with customer details, payment summary and filters',
  })
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
      includePaymentCollector: true,
      limit,
      skip,
      storeIds,
      transferGrantedOrderIds,
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/export')
  @response(200, {
    description:
      'All matching Manage Ticket records within the caller store scope',
  })
  async exportOrders(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.object('filter', {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerName: {type: 'string'},
        orderId: {type: 'string'},
        placedBy: {type: 'string'},
        source: {type: 'string'},
        orderType: {type: 'string'},
        status: {type: 'string'},
        paymentStatus: {type: 'string'},
        dateFrom: {type: 'string', anyOf: [{format: 'date'}, {format: 'date-time'}]},
        dateTo: {type: 'string', anyOf: [{format: 'date'}, {format: 'date-time'}]},
        storeId: {type: 'string'},
        clusterId: {type: 'string'},
      },
    })
    filter: OrderExportFilters = {},
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {
      storeId:
        filter.storeId && filter.storeId !== 'all' ? filter.storeId : undefined,
      clusterId:
        filter.clusterId && filter.clusterId !== 'all'
          ? filter.clusterId
          : undefined,
    });
    // Manage Ticket exports only orders owned by accessible stores, not transfer grants.
    return this.orderService.exportOrders(filter, storeIds);
  }

  // The customer's security deposit doubles as their on-account credit limit
  // — read-only status for billing, independent of order creation.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/on-account-credit/{customerId}')
  @response(200, {
    description: 'On-account credit limit/used/remaining for a customer',
  })
  async onAccountCreditStatus(
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    return this.orderService.computeOnAccountCreditStatus(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}')
  @response(200, {
    description: 'Order with items, charges, payments and status history',
  })
  async findById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser!);
    return this.orderService.getOrderDetails(id);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['delivery:read']})
  @get('/orders/{id}/delivery-management')
  @response(200, {description: 'Delivery Management ticket detail with images'})
  async deliveryManagementDetail(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    const order = await this.orderRepository.findOne({
      where: {id, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const [customer, delivered, stops, payments, handover, balance, legacyReturn] =
      await Promise.all([
        this.customerRepository.findOne({
          where: {id: order.customerId, isDeleted: false},
        }),
        this.statusHistoryRepository.findOne({
          where: {orderId: id, status: OrderStatus.DELIVERED},
          order: ['changedAt DESC'],
        }),
        this.deliveryOrderRepository.find({
          where: {orderId: id} as object,
          order: ['createdAt DESC'],
          limit: 1,
        }),
        this.paymentTransactionRepository.find({
          where: {orderId: id},
          order: ['paymentDate DESC'],
        }),
        this.orderHandoverRepository.findOne({
          where: {orderId: id, isDeleted: false} as object,
          order: ['handedOverAt DESC'],
        }),
        this.orderService.computeBalanceDue(order),
        order.status === OrderStatus.READY && order.deliveryAttemptCount && !order.assignedRiderId
          ? this.statusHistoryRepository.findOne({
              where: {orderId: id, status: OrderStatus.READY},
              order: ['changedAt DESC'],
            })
          : Promise.resolve(null),
      ]);
    const legacyReason = stops[0]?.status !== DeliveryOrderStatus.RETURN_TO_STORE &&
      legacyReturn?.remarks?.startsWith('Delivery attempt failed — returned to store: ')
      ? legacyReturn.remarks.slice('Delivery attempt failed — returned to store: '.length)
      : null;
    const mediaIds = [
      ...new Set([
        ...(order.specialInstructionMediaIds ?? []),
        ...(handover?.photoMediaId ? [handover.photoMediaId] : []),
      ]),
    ];
    const media = mediaIds.length
      ? await this.mediaRepository.find({
          where: {id: {inq: mediaIds}, isActive: true} as object,
        })
      : [];
    const mediaById = new Map(
      media
        .filter(file => file.fileType.startsWith('image/'))
        .map(file => [file.id, {id: file.id, fileUrl: file.fileUrl}]),
    );

    return {
      orderId: id,
      ticketNumber: order.orderNumber,
      currentDeliveryStatus: legacyReason ? DeliveryOrderStatus.RETURN_TO_STORE : stops[0]?.status ?? order.status ?? null,
      customerName: customer
        ? `${customer.firstName} ${customer.lastName ?? ''}`.trim()
        : null,
      address: order.deliveryAddress ?? null,
      assignedRiderName: order.assignedRiderName ?? null,
      deliverySpeed: order.deliveryType ?? null,
      deliveryType:
        order.deliveryMethod ??
        (order.orderType === OrderType.HOME_PICKUP_HOME_DELIVERY ||
        order.orderType === OrderType.STORE_DROPOFF_HOME_DELIVERY
          ? OrderDeliveryMethod.HOME_DELIVERY
          : OrderDeliveryMethod.STORE_PICKUP),
      estimatedDeliveryAt: order.deliveryDate ?? null,
      deliverySlot: order.deliverySlot ?? null,
      actualDeliveryAt: delivered?.changedAt ?? handover?.handedOverAt ?? null,
      totalAmount: Number(order.totalAmount ?? 0),
      collectedAmount: balance.alreadyPaid,
      balanceDue: balance.due,
      paymentMode:
        payments.find(payment => payment.transactionType !== 'refund')
          ?.paymentMode ?? null,
      paymentStatus: resolveOrderPaymentStatus(
        Number(order.totalAmount ?? 0),
        balance.alreadyPaid,
        order.status,
      ),
      deliveryRemarks: delivered?.remarks ?? null,
      deliveryReturnRemarks: legacyReason ?? stops[0]?.failureRemarks ?? null,
      remarkImages: (order.specialInstructionMediaIds ?? [])
        .map(mediaId => mediaById.get(mediaId))
        .filter((file): file is {id: string; fileUrl: string} => !!file),
      proofImage: mediaById.get(handover?.photoMediaId ?? '') ?? null,
    };
  }

  // ─── Update Order Metadata ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{id}')
  @response(200, {description: 'Order updated'})
  async updateById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              deliveryDate: {
                type: 'string', format: 'date-time',
                description: 'For an active rider run, reschedule with POST /orders/delivery-assignment.',
              },
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {
                type: 'array',
                items: {type: 'string'},
              },
              remarks: {type: 'string'},
              orderLabelIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description:
                  "Replaces the order's labels wholesale. Omit to leave labels " +
                  'untouched; send [] to clear all of them.',
              },
              assignedRiderId: {
                type: 'string',
                format: 'uuid',
                description: 'Use POST /orders/delivery-assignment instead; PATCH rejects this field.',
              },
              deliveryMethod: {
                type: 'string',
                enum: Object.values(OrderDeliveryMethod),
              },
              deliverySlot: {
                type: 'string',
                description: 'For an active rider run, reschedule with POST /orders/delivery-assignment.',
              },
              deliverySlotId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Resolved into a frozen deliverySlot text snapshot on save.',
              },
              deliveryAddressId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Resolved into a frozen deliveryAddress text snapshot on save.',
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
    const order = await this.orderRepository.findOne({
      where: {id, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, order.storeId)) {
      throw new HttpErrors.NotFound('Order not found.');
    }
    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.RETURNED
    ) {
      throw new HttpErrors.BadRequest(
        'Cannot update a delivered, cancelled, or returned order.',
      );
    }
    if (['deliveryType', 'deliveryTypePercentage', 'expressMultiplier']
      .some(key => Object.prototype.hasOwnProperty.call(body, key))) {
      throw new HttpErrors.BadRequest('Update delivery charges with the order items so the ticket is repriced.');
    }
    const {
      orderLabelIds,
      assignedRiderId,
      deliveryAddressId,
      deliverySlotId,
      ...orderFields
    } = body;
    if (assignedRiderId !== undefined) {
      throw new HttpErrors.BadRequest(
        'Assign or reassign riders with POST /orders/delivery-assignment.',
      );
    }

    if (deliveryAddressId !== undefined) {
      const address = await this.customerAddressRepository.findOne({
        where: {id: deliveryAddressId, isDeleted: false} as object,
      });
      if (!address)
        throw new HttpErrors.BadRequest('Delivery address not found.');
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

    if (body.deliveryMethod === OrderDeliveryMethod.STORE_PICKUP) {
      const {v4} = await import('uuid');
      const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
      try {
        await this.dataSource.execute(
          'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
          [id], {transaction: tx},
        );
        const lockedOrder = await this.orderRepository.findOne({
          where: {id, isDeleted: false},
        }, {transaction: tx});
        if (!lockedOrder || !this.storeScopeService.allows(scope, lockedOrder.storeId)) {
          throw new HttpErrors.NotFound('Order not found.');
        }
        if (lockedOrder.status === OrderStatus.DELIVERED ||
            lockedOrder.status === OrderStatus.CANCELLED ||
            lockedOrder.status === OrderStatus.RETURNED) {
          throw new HttpErrors.Conflict('Order status changed. Refresh and retry.');
        }
        if (lockedOrder.status === OrderStatus.OUT_FOR_DELIVERY) {
          throw new HttpErrors.Conflict('An in-progress delivery cannot be changed to store pickup.');
        }

        const oldStops = await this.deliveryOrderRepository.find({
          where: {orderId: id} as object,
        }, {transaction: tx});
        const runIds = [...new Set(oldStops.map(stop => stop.deliveryId))].sort();
        for (const runId of runIds) {
          await this.dataSource.execute(
            'SELECT id FROM public.delivery WHERE id = $1 FOR UPDATE',
            [runId], {transaction: tx},
          );
        }
        const runs = runIds.length ? await this.deliveryRepository.find({
          where: {id: {inq: runIds},
            status: {inq: [DeliveryStatus.ASSIGNED, DeliveryStatus.OUT_FOR_DELIVERY]},
            isDeleted: false} as object,
        }, {transaction: tx}) : [];
        for (const bagId of [...new Set(runs.map(run => run.bagId)
          .filter((value): value is string => !!value))].sort()) {
          await this.dataSource.execute(
            'SELECT id FROM public.bag WHERE id = $1 FOR UPDATE',
            [bagId], {transaction: tx},
          );
        }
        for (const run of runs) {
          const stops = await this.deliveryOrderRepository.find({
            where: {deliveryId: run.id} as object,
          }, {transaction: tx});
          const moving = stops.filter(stop => stop.orderId === id &&
            stop.status !== DeliveryOrderStatus.RETURN_TO_STORE &&
            stop.status !== DeliveryOrderStatus.DELIVERED);
          if (!moving.length) continue;
          if (run.status !== DeliveryStatus.ASSIGNED ||
              moving.some(stop => stop.status && stop.status !== DeliveryOrderStatus.PENDING)) {
            throw new HttpErrors.Conflict('An in-progress delivery cannot be changed to store pickup.');
          }
          if (moving.length === stops.length) {
            await this.deliveryRepository.updateById(run.id, {
              status: DeliveryStatus.CANCELLED, cancelledAt: new Date(),
              cancelledBy: currentUser[securityId],
            }, {transaction: tx});
            await this.deliveryCustodyEventRepository.create({
              id: v4(), deliveryId: run.id,
              eventType: DeliveryCustodyEventType.CANCELLED,
              performedBy: currentUser[securityId],
            }, {transaction: tx});
            if (run.bagId) {
              const bag = await this.bagRepository.findById(
                run.bagId, undefined, {transaction: tx},
              );
              if (bag.currentDeliveryId === run.id) {
                await this.bagRepository.updateById(run.bagId, {
                  status: BagStatus.AVAILABLE,
                  currentDeliveryId: null as unknown as string,
                }, {transaction: tx});
                await this.deliveryCustodyEventRepository.create({
                  id: v4(), deliveryId: run.id,
                  eventType: DeliveryCustodyEventType.BAG_RELEASED,
                  performedBy: currentUser[securityId],
                }, {transaction: tx});
              }
            }
          } else {
            for (const stop of moving) {
              await this.deliveryOrderRepository.deleteById(stop.id, {transaction: tx});
            }
            await this.deliveryRepository.updateById(run.id, {
              orderCount: stops.length - moving.length,
            }, {transaction: tx});
          }
        }

        await this.orderRepository.updateById(id, {
          ...orderFields,
          deliveryMethod: OrderDeliveryMethod.STORE_PICKUP,
          assignedRiderId: null as unknown as string,
          assignedRiderName: null as unknown as string,
          deliverySlot: null as unknown as string,
          deliverySlotId: null as unknown as string,
        }, {transaction: tx});
        if (orderLabelIds !== undefined) {
          await this.orderLabelAssignmentRepository.deleteAll(
            {orderId: id}, {transaction: tx},
          );
          for (const orderLabelId of orderLabelIds) {
            await this.orderLabelAssignmentRepository.create({
              orderId: id, orderLabelId,
            }, {transaction: tx});
          }
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      return {message: 'Order updated.'};
    }

    if (body.deliveryDate !== undefined || body.deliverySlot !== undefined ||
        deliverySlotId !== undefined) {
      const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
      try {
        await this.dataSource.execute(
          'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
          [id], {transaction: tx},
        );
        const lockedOrder = await this.orderRepository.findOne({
          where: {id, isDeleted: false},
        }, {transaction: tx});
        if (!lockedOrder || !this.storeScopeService.allows(scope, lockedOrder.storeId)) {
          throw new HttpErrors.NotFound('Order not found.');
        }
        if (lockedOrder.status === OrderStatus.DELIVERED ||
            lockedOrder.status === OrderStatus.CANCELLED ||
            lockedOrder.status === OrderStatus.RETURNED) {
          throw new HttpErrors.Conflict('Order status changed. Refresh and retry.');
        }
        const stops = await this.deliveryOrderRepository.find({
          where: {orderId: id} as object,
        }, {transaction: tx});
        const activeStops = stops.filter(stop =>
          stop.status !== DeliveryOrderStatus.RETURN_TO_STORE &&
          stop.status !== DeliveryOrderStatus.DELIVERED);
        if (activeStops.length) {
          const runs = await this.deliveryRepository.find({
            where: {id: {inq: [...new Set(activeStops.map(stop => stop.deliveryId))]},
              status: {inq: [DeliveryStatus.ASSIGNED, DeliveryStatus.OUT_FOR_DELIVERY]},
              isDeleted: false} as object,
          }, {transaction: tx});
          if (runs.length) {
            throw new HttpErrors.Conflict(
              'Change an assigned delivery schedule with POST /orders/delivery-assignment.',
            );
          }
        }
        await this.orderRepository.updateById(id, orderFields, {transaction: tx});
        if (orderLabelIds !== undefined) {
          await this.orderLabelAssignmentRepository.deleteAll(
            {orderId: id}, {transaction: tx},
          );
          for (const orderLabelId of orderLabelIds) {
            await this.orderLabelAssignmentRepository.create({
              orderId: id, orderLabelId,
            }, {transaction: tx});
          }
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      return {message: 'Order updated.'};
    }

    if (Object.keys(orderFields).length > 0) {
      await this.orderRepository.updateById(id, orderFields);
    }

    // Distinguish "field omitted" (leave labels alone) from "sent as []"
    // (clear every label) — an order can validly have zero labels.
    if (orderLabelIds !== undefined) {
      await this.orderLabelAssignmentRepository.deleteAll({orderId: id});
      for (const orderLabelId of orderLabelIds) {
        await this.orderLabelAssignmentRepository.create({
          orderId: id,
          orderLabelId,
        });
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
              orderIds: {
                type: 'array',
                minItems: 1,
                items: {type: 'string', format: 'uuid'},
              },
              riderId: {type: 'string', format: 'uuid'},
              deliverySlot: {type: 'string'},
              deliverySlotId: {
                type: 'string',
                format: 'uuid',
                description:
                  "If given, overrides deliverySlot with this slot's label.",
              },
              deliveryDate: {type: 'string', format: 'date-time'},
              deliveryAddressId: {type: 'string', format: 'uuid'},
              deliveryAddress: {type: 'string'},
              remarks: {type: 'string'},
              bagId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Optional. When given, attaches a custody bag to the rider-visible Delivery run.',
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
      deliveryAddressId?: string;
      deliveryAddress?: string;
      remarks?: string;
      bagId?: string;
    },
  ): Promise<object> {
    const rider = await this.riderRepository.findOne({
      where: {id: body.riderId, isDeleted: false},
    });
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    if (!rider.isActive)
      throw new HttpErrors.BadRequest('This rider is inactive.');
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
    await this.riderAssignmentService.assertRiderRostered(
      body.riderId,
      slotWindow,
    );

    let orders = await this.orderRepository.find({
      where: {id: {inq: body.orderIds}, isDeleted: false} as object,
    });
    if (orders.length !== body.orderIds.length) {
      throw new HttpErrors.NotFound('One or more orders were not found.');
    }
    const scope = await this.storeScopeService.resolve(currentUser);
    if (orders.some(order => !this.storeScopeService.allows(scope, order.storeId))) {
      throw new HttpErrors.NotFound('One or more orders were not found.');
    }
    if ((body.deliveryAddressId !== undefined || body.deliveryAddress !== undefined) &&
        body.orderIds.length !== 1) {
      throw new HttpErrors.BadRequest('A delivery address can only be set for one order at a time.');
    }
    const notDeliverable = orders.filter(
      o =>
        o.status !== OrderStatus.READY &&
        o.status !== OrderStatus.PARTIALLY_DISPATCHED,
    );
    if (notDeliverable.length) {
      throw new HttpErrors.BadRequest(
        `Order(s) with status ${notDeliverable.map(o => o.status).join(', ')} are not ready for delivery assignment.`,
      );
    }
    await this.orderService.assertGarmentsReadyForDelivery(body.orderIds);
    // Prevents accidentally batching cross-store orders into one rider run —
    // Rider has no storeId relation today, so this is the closest available check.
    const storeIds = new Set(orders.map(o => o.storeId));
    if (storeIds.size > 1) {
      throw new HttpErrors.BadRequest(
        'All orders in one assignment must belong to the same store.',
      );
    }
    // A garment can visit other stores for processing via interstore
    // transfer, but dispatch to the customer only happens from home —
    // block it if anything is still away.
    await this.orderService.assertGarmentsHomeForDispatch(body.orderIds);

    let deliverySlot = body.deliverySlot;
    if (body.deliverySlotId !== undefined) {
      const slot = await this.pickupDeliverySlotRepository.findOne({
        where: {id: body.deliverySlotId, isDeleted: false} as object,
      });
      if (!slot) throw new HttpErrors.BadRequest('Delivery slot not found.');
      deliverySlot = slot.label;
    }

    // A bag is optional; every assignment creates or reuses a rider-visible run.
    let bag = null;
    if (body.bagId !== undefined) {
      bag = await this.bagRepository.findOne({
        where: {id: body.bagId, isDeleted: false},
      });
      if (!bag) throw new HttpErrors.NotFound('Bag not found.');
      if (!bag.isActive)
        throw new HttpErrors.BadRequest('This bag is inactive.');
    }

    const {v4} = await import('uuid');
    const assignedRiderName = `${rider.firstName} ${rider.lastName}`;
    const deliveryDate = new Date(body.deliveryDate);

    const tx = await this.dataSource.beginTransaction(
      IsolationLevel.READ_COMMITTED,
    );
    try {
      // Serialize repeated assignments for the same orders before checking
      // their current runs, including retries arriving at the same time.
      for (const id of [...body.orderIds].sort()) {
        await this.dataSource.execute(
          'SELECT id FROM public.orders WHERE id = $1 FOR UPDATE',
          [id], {transaction: tx},
        );
      }
      orders = await this.orderRepository.find({
        where: {id: {inq: body.orderIds}, isDeleted: false} as object,
      }, {transaction: tx});
      if (orders.some(order => !this.storeScopeService.allows(scope, order.storeId))) {
        throw new HttpErrors.NotFound('One or more orders were not found.');
      }
      if (orders.length !== body.orderIds.length || orders.some(order =>
        order.status !== OrderStatus.READY &&
        order.status !== OrderStatus.PARTIALLY_DISPATCHED)) {
        throw new HttpErrors.Conflict('Order status changed. Refresh and retry.');
      }
      let addressFields: {deliveryAddressId?: string; deliveryAddress?: string} = {};
      if (body.deliveryAddressId !== undefined) {
        const address = await this.customerAddressRepository.findOne({
          where: {id: body.deliveryAddressId, customerId: orders[0].customerId, isDeleted: false} as object,
        }, {transaction: tx});
        if (!address) throw new HttpErrors.BadRequest('Delivery address not found for this customer.');
        addressFields = {
          deliveryAddressId: address.id,
          deliveryAddress: this.customerAddressService.toDisplaySnapshot(address),
        };
      } else if (body.deliveryAddress !== undefined) {
        const address = body.deliveryAddress.trim();
        if (!address) throw new HttpErrors.BadRequest('Delivery address is required.');
        addressFields = {deliveryAddressId: null as unknown as string, deliveryAddress: address};
      }
      if (Object.keys(addressFields).length) Object.assign(orders[0], addressFields);
      // Validate the address after locking its order so a concurrent address
      // edit cannot change the pincode between validation and assignment.
      const addressIds = [...new Set(orders.map(order => order.deliveryAddressId)
        .filter((id): id is string => Boolean(id)))];
      if (addressIds.length) {
        const addresses = await this.customerAddressRepository.find({
          where: {id: {inq: addressIds}} as object,
        }, {transaction: tx});
        const pincodeByAddressId = new Map(addresses.map(address => [address.id, address.pincode]));
        for (const order of orders) {
          await this.riderAssignmentService.assertRiderCoversPincode(
            body.riderId,
            order.deliveryAddressId ? pincodeByAddressId.get(order.deliveryAddressId) : undefined,
          );
        }
      }
      const oldStops = await this.deliveryOrderRepository.find({
        where: {orderId: {inq: body.orderIds}} as object,
      }, {transaction: tx});
      const oldRunIds = [...new Set(oldStops.map(stop => stop.deliveryId))].sort();
      for (const id of oldRunIds) {
        await this.dataSource.execute(
          'SELECT id FROM public.delivery WHERE id = $1 FOR UPDATE',
          [id], {transaction: tx},
        );
      }
      const oldRuns = oldRunIds.length ? await this.deliveryRepository.find({
        where: {id: {inq: oldRunIds},
          status: {inq: [DeliveryStatus.ASSIGNED, DeliveryStatus.OUT_FOR_DELIVERY]},
          isDeleted: false} as object,
      }, {transaction: tx}) : [];
      for (const id of [...new Set([body.bagId, ...oldRuns.map(run => run.bagId)].filter(
        (value): value is string => !!value,
      ))].sort()) {
        await this.dataSource.execute(
          'SELECT id FROM public.bag WHERE id = $1 FOR UPDATE',
          [id], {transaction: tx},
        );
      }
      const selectedIds = new Set(body.orderIds);
      const latestRun = oldRuns.sort((a, b) =>
        new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime())[0];
      const latestStops = body.orderIds.length === 1 && latestRun
        ? await this.deliveryOrderRepository.find({
            where: {deliveryId: latestRun.id} as object,
          }, {transaction: tx}) : [];
      const reusable = latestRun?.status === DeliveryStatus.ASSIGNED &&
        latestStops.length === 1 && latestStops[0].orderId === body.orderIds[0] &&
        (!latestStops[0].status || latestStops[0].status === DeliveryOrderStatus.PENDING) &&
        (!latestRun.bagId || latestRun.riderId === body.riderId) &&
        (!bag || bag.id === latestRun.bagId) ? latestRun : undefined;
      for (const run of oldRuns) {
        if (run.id === reusable?.id) continue;
        const stops = await this.deliveryOrderRepository.find({
          where: {deliveryId: run.id} as object,
        }, {transaction: tx});
        const moving = stops.filter(stop => selectedIds.has(stop.orderId) &&
          stop.status !== DeliveryOrderStatus.RETURN_TO_STORE &&
          stop.status !== DeliveryOrderStatus.DELIVERED);
        if (!moving.length) continue;
        if (run.status !== DeliveryStatus.ASSIGNED ||
            moving.some(stop => stop.status && stop.status !== DeliveryOrderStatus.PENDING)) {
          throw new HttpErrors.Conflict('An in-progress delivery cannot be reassigned.');
        }
        if (moving.length === stops.length) {
          await this.deliveryRepository.updateById(run.id, {
            status: DeliveryStatus.CANCELLED, cancelledAt: new Date(),
            cancelledBy: currentUser[securityId],
          }, {transaction: tx});
          await this.deliveryCustodyEventRepository.create({
            id: v4(), deliveryId: run.id,
            eventType: DeliveryCustodyEventType.CANCELLED,
            performedBy: currentUser[securityId],
          }, {transaction: tx});
          if (run.bagId) {
            const currentBag = await this.bagRepository.findById(
              run.bagId, undefined, {transaction: tx},
            );
            if (currentBag.currentDeliveryId === run.id) {
              await this.bagRepository.updateById(run.bagId, {
                status: reusable?.bagId === run.bagId ? BagStatus.IN_USE : BagStatus.AVAILABLE,
                currentDeliveryId: (reusable?.bagId === run.bagId ? reusable.id : null) as unknown as string,
              }, {transaction: tx});
              await this.deliveryCustodyEventRepository.create({
                id: v4(), deliveryId: run.id,
                eventType: DeliveryCustodyEventType.BAG_RELEASED,
                performedBy: currentUser[securityId],
              }, {transaction: tx});
            }
          }
        } else {
          for (const stop of moving) {
            await this.deliveryOrderRepository.deleteById(stop.id, {transaction: tx});
          }
          await this.deliveryRepository.updateById(run.id, {
            orderCount: stops.length - moving.length,
          }, {transaction: tx});
        }
      }
      if (bag && bag.id !== reusable?.bagId) {
        const currentBag = await this.bagRepository.findById(bag.id, undefined, {transaction: tx});
        if (currentBag.status !== BagStatus.AVAILABLE) {
          throw new HttpErrors.Conflict(`Bag ${bag.bagNumber} is already in use.`);
        }
      }
      for (const order of orders) {
        await this.orderRepository.updateById(
          order.id,
          {
            deliveryMethod: OrderDeliveryMethod.HOME_DELIVERY,
            assignedRiderId: body.riderId,
            assignedRiderName,
            deliverySlot,
            deliverySlotId: (body.deliverySlotId ?? null) as unknown as string,
            deliveryDate,
            ...addressFields,
            ...(body.remarks ? {remarks: body.remarks} : {}),
          },
          {transaction: tx},
        );
      }

      // Keep the existing single-order run when rescheduling. New assignments
      // still need a Delivery because the rider app reads this table, not
      // Order.assignedRiderId.
      const store = await this.storeRepository.findOne({
        where: {id: orders[0].storeId},
      });
      const customers = await this.customerRepository.find({
        where: {
          id: {inq: [...new Set(orders.map(o => o.customerId))]},
        } as object,
      });
      const customerById = new Map(customers.map(c => [c.id, c]));

      const now = new Date();
      const ddMM = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const seq = reusable ? 0 : (await this.deliveryRepository.count()).count + 1;
      const deliveryNumber = reusable?.deliveryNumber ?? `DL-${store?.code ?? 'ST'}-${ddMM}-${seq}`;
      const scheduleChanged = reusable && (
        reusable.riderId !== body.riderId ||
        new Date(reusable.deliveryDate ?? 0).getTime() !== deliveryDate.getTime() ||
        (reusable.deliverySlotId ?? null) !== (body.deliverySlotId ?? null) ||
        reusable.deliverySlot !== deliverySlot
      );
      // assignedAt doubles as the notification revision for a reused run.
      // Keep it on retries, but advance it even for changes within one ms.
      const assignedAt = reusable && !scheduleChanged ? reusable.assignedAt :
        new Date(Math.max(now.getTime(),
          reusable ? new Date(reusable.assignedAt).getTime() + 1 : 0));

      const delivery: Delivery = reusable
        ? await this.deliveryRepository.updateById(reusable.id, {
            riderId: body.riderId, riderName: assignedRiderName,
            deliverySlot, deliverySlotId: (body.deliverySlotId ?? null) as unknown as string,
            deliveryDate,
            assignedAt, assignedBy: currentUser[securityId],
            remarks: body.remarks,
          }, {transaction: tx}).then(() => this.deliveryRepository.findById(reusable.id, undefined, {transaction: tx}))
        : await this.deliveryRepository.create(
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

      for (const order of reusable ? [] : orders) {
        const customer = customerById.get(order.customerId);
        const {due} = await this.orderService.computeBalanceDue(order);
        await this.deliveryOrderRepository.create(
          {
            id: v4(),
            deliveryId: delivery.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: customer
              ? `${customer.firstName} ${customer.lastName}`
              : 'Customer',
            balanceDueAtAssignment: due,
          },
          {transaction: tx},
        );
      }

      if (!reusable) await this.deliveryCustodyEventRepository.create(
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
          {
            status: BagStatus.IN_USE,
            currentDeliveryId: delivery.id,
            currentStoreId: orders[0].storeId,
          },
          {transaction: tx},
        );
      }

      await tx.commit();

      // Not awaited — a slow/unreachable FCM call must never delay this
      // response. NotificationService already swallows its own errors.
      this.orderService.notifyDeliveryAssigned(delivery.id);
      const previousRiderIds = new Set(
        orders
          .map(o => o.assignedRiderId)
          .filter(
            (riderId): riderId is string =>
              Boolean(riderId) && riderId !== body.riderId,
          ),
      );
      Promise.all([
        this.notificationService.notifyRider(body.riderId, {
          type: RIDER_NOTIFICATION_TYPES.DELIVERY_ASSIGNED,
          title: 'New delivery assigned',
          body:
            orders.length > 1
              ? `${orders.length} deliveries assigned to you for ${deliverySlot}.`
              : `A delivery has been assigned to you for ${deliverySlot}.`,
          data: {
            deliveryId: delivery.id,
            deliveryNumber,
            orderIds: body.orderIds.join(','),
          },
        }),
        ...[...previousRiderIds].map(oldRiderId =>
          this.notificationService.notifyRider(oldRiderId, {
            type: RIDER_NOTIFICATION_TYPES.DELIVERY_REASSIGNED,
            title: 'Delivery reassigned',
            body: 'A delivery previously assigned to you has been reassigned to another rider.',
            data: {deliveryId: delivery.id, deliveryNumber},
          }),
        ),
      ]).catch(() => {});

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
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    const changedBy = currentUser[securityId];
    const result = await this.orderService.changeStatus(
      id,
      body.status,
      changedBy,
      body.remarks,
    );

    if (body.status === OrderStatus.READY && this.systemNotificationService) {
      this.orderRepository
        .findById(id)
        .then(async readyOrder => {
          let customerName: string | undefined;
          try {
            if (readyOrder?.customerId) {
              const cust = await this.customerRepository.findById(
                readyOrder.customerId,
              );
              if (cust) {
                customerName = [cust.firstName, cust.lastName]
                  .filter(Boolean)
                  .join(' ')
                  .trim();
              }
            }
          } catch (_) {}
          return this.systemNotificationService!.notifyOrderReady(
            readyOrder,
            customerName,
          );
        })
        .catch(err => {
          console.error('Failed to notify super admin for ready order:', err);
        });
    }

    const response: Record<string, unknown> = {
      message: `Order status changed to '${body.status}'.`,
    };
    if ((result as any).garments?.length) {
      response.garments = (result as any).garments;
      response.note = `${(result as any).garments.length} garments auto-created. Add brand, color and inspection details to each.`;
    }
    return response;
  }

  // ─── Delivery Return (failed/undeliverable attempt) ────────────────────────
  // A failed stop remains return_to_store after its order returns to ready.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/delivery-return')
  @response(200, {
    description:
      'Order ready for redispatch; delivery stop marked return to store',
  })
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
                description:
                  'Why the delivery attempt failed / the order came back to the store.',
              },
              reasons: {
                type: 'array',
                description:
                  'Optional structured reasons, alongside remarks — see DeliveryFailureReason.',
                items: {
                  type: 'string',
                  enum: Object.values(DeliveryFailureReason),
                },
              },
              otherReason: {
                type: 'string',
                description: 'Required when reasons includes "other".',
              },
            },
          },
        },
      },
    })
    body: {
      remarks: string;
      reasons?: DeliveryFailureReason[];
      otherReason?: string;
    },
  ): Promise<object> {
    const updated = await this.orderService.returnDeliveryToStore({
      orderId: id,
      remarks: body.remarks,
      reasons: body.reasons,
      otherReason: body.otherReason,
      changedBy: currentUser[securityId],
    });
    const stops = await this.deliveryOrderRepository.find({
      where: {orderId: id} as object,
      order: ['createdAt DESC'],
      limit: 1,
    });
    const deliveryId = stops[0].deliveryId;
    const runStops = await this.deliveryOrderRepository.find({where: {deliveryId} as object});
    if (runStops.every(stop =>
      stop.status === DeliveryOrderStatus.DELIVERED ||
      stop.status === DeliveryOrderStatus.RETURN_TO_STORE,
    )) {
      const run = await this.deliveryRepository.findById(deliveryId);
      if (run.status !== DeliveryStatus.COMPLETED) {
        const {v4} = await import('uuid');
        const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
        try {
          await this.deliveryRepository.updateById(deliveryId, {
            status: DeliveryStatus.COMPLETED,
            completedAt: new Date(),
            completedBy: currentUser[securityId],
          }, {transaction: tx});
          if (run.bagId) {
            await this.bagRepository.updateById(run.bagId, {
              status: BagStatus.AVAILABLE,
              currentDeliveryId: null as unknown as string,
            }, {transaction: tx});
            await this.deliveryCustodyEventRepository.create({
              id: v4(), deliveryId, eventType: DeliveryCustodyEventType.BAG_RELEASED,
              performedBy: currentUser[securityId],
            }, {transaction: tx});
          }
          await this.deliveryCustodyEventRepository.create({
            id: v4(), deliveryId, eventType: DeliveryCustodyEventType.COMPLETED,
            performedBy: currentUser[securityId],
          }, {transaction: tx});
          await tx.commit();
        } catch (error) {
          await tx.rollback();
          throw error;
        }
      }
    }
    return {
      message: 'Delivery returned to store. Order is ready for redispatch.',
      order: updated,
    };
  }

  // ─── Edit Order Items ─────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @put('/orders/{id}/draft')
  @response(200, {description: 'Draft ticket saved'})
  async saveDraftOrder(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({content: {'application/json': {schema: {
      type: 'object',
      required: ['customerId', 'orderType', 'orderLabelIds', 'items', 'additionalChargeIds', 'couponCodes', 'paymentIsOnAccount'],
      properties: {
        customerId: {type: 'string', format: 'uuid'},
        storeId: {type: 'string', format: 'uuid'},
        orderType: {type: 'string', enum: Object.values(OrderType)},
        orderLabelIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
        specialInstructions: {type: 'string'},
        remarks: {type: 'string'},
        deliveryAddressId: {type: 'string', format: 'uuid', nullable: true},
        deliveryAddress: {type: 'string'},
        deliveryType: {type: 'string', enum: Object.values(DeliveryType)},
        deliveryTypePercentage: {type: 'number', minimum: 0},
        expressMultiplier: {type: 'number', minimum: 1},
        deliveryDate: {type: 'string', format: 'date-time'},
        items: {type: 'array', minItems: 1, items: EDIT_ORDER_ITEM_SCHEMA},
        additionalChargeIds: {type: 'array', items: ADDITIONAL_CHARGE_SELECTION_SCHEMA},
        couponCodes: {type: 'array', items: {type: 'string'}},
        customerContactId: {type: 'string', format: 'uuid', nullable: true},
        familyGroupMemberId: {type: 'string', format: 'uuid', nullable: true},
        paymentIsOnAccount: {type: 'boolean'},
        draftEditorState: {type: 'object'},
      },
    }}}})
    body: Parameters<OrderService['saveDraftOrder']>[1],
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    if (body.storeId) {
      const scope = await this.storeScopeService.resolve(currentUser);
      if (!this.storeScopeService.allows(scope, body.storeId)) {
        throw new HttpErrors.NotFound('Store not found.');
      }
    }
    let deliveryAddressId = body.deliveryAddressId;
    let deliveryAddress = body.deliveryAddress;
    if (deliveryAddressId) {
      const address = await this.customerAddressRepository.findOne({
        where: {id: deliveryAddressId, isDeleted: false} as object,
      });
      if (!address) throw new HttpErrors.BadRequest('Delivery address not found.');
      if (address.customerId !== body.customerId) {
        const group = await this.customerFamilyGroupRepository.findOne({
          where: {primaryCustomerId: address.customerId, isActive: true, isDeleted: false} as object,
        });
        const member = group ? await this.customerFamilyGroupMemberRepository.findOne({
          where: {groupId: group.id, customerId: body.customerId, isActive: true, isDeleted: false} as object,
        }) : null;
        if (!member) throw new HttpErrors.BadRequest('Delivery address does not belong to this customer.');
      }
      deliveryAddress = this.customerAddressService.toDisplaySnapshot(address);
    } else if (deliveryAddress !== undefined) {
      deliveryAddressId = null;
    }
    return this.orderService.saveDraftOrder(id, {
      ...body, deliveryAddressId, deliveryAddress,
    }, currentUser[securityId]);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @put('/orders/{id}/items')
  @response(200, {
    description: 'Order items replaced, totals and garments reconciled',
  })
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
              deliveryType: {type: 'string', enum: Object.values(DeliveryType)},
              deliveryTypePercentage: {type: 'number', minimum: 0},
              expressMultiplier: {type: 'number', minimum: 0},
              deliveryDate: {type: 'string', format: 'date-time'},
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
                    additionalServiceIds: {
                      type: 'array',
                      items: {type: 'string', format: 'uuid'},
                    },
                    additionalChargeIds: {
                      type: 'array',
                      items: ADDITIONAL_CHARGE_SELECTION_SCHEMA,
                    },
                    specialInstructions: {type: 'string'},
                    specialInstructionMediaIds: {
                      type: 'array',
                      items: {type: 'string'},
                    },
                    remarks: {type: 'string'},
                    units: {
                      type: 'array',
                      items: EDIT_ORDER_UNIT_SCHEMA,
                      description:
                        'Optional per-piece selections, one per unit of quantity. Per-unit ' +
                        'additionalServiceIds/additionalChargeIds override the line-level lists; ' +
                        'without units every piece gets the line-level lists.',
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
    body: {
      deliveryType?: DeliveryType;
      deliveryTypePercentage?: number;
      expressMultiplier?: number;
      deliveryDate?: string;
      items: {
        serviceId: string;
        itemId: string;
        quantity: number;
        additionalServiceIds?: string[];
        additionalChargeIds?: Array<
          string | {additionalChargeId: string; quantity: number}
        >;
        specialInstructions?: string;
        specialInstructionMediaIds?: string[];
        remarks?: string;
        units?: EditOrderUnitInput[];
      }[];
    },
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    const pendingDowngrades = await this.approvalRequestRepo.find({where: {
      entityType: 'order', entityId: id,
      type: ApprovalRequestType.ORDER_ITEMS_DOWNGRADE,
      status: ApprovalRequestStatus.PENDING,
    } as object});
    const hasLegacyPending = pendingDowngrades.some(request => !request.metadata?._appliedAtRequest);
    const result = (await this.orderService.updateOrderItems(
      id,
      body.items,
      currentUser[securityId],
      {
        deliveryType: body.deliveryType,
        deliveryTypePercentage: body.deliveryTypePercentage,
        expressMultiplier: body.expressMultiplier,
        deliveryDate: body.deliveryDate,
        trackItemChanges: hasLegacyPending,
        beforeCommit: async (downgrade, transaction, itemsChanged) => {
          const pending = await this.approvalRequestRepo.find({where: {
            entityType: 'order', entityId: id,
            type: ApprovalRequestType.ORDER_ITEMS_DOWNGRADE,
            status: ApprovalRequestStatus.PENDING,
          } as object}, {transaction});
          for (const request of pending.filter(row => !row.metadata?._appliedAtRequest)) {
            if (itemsChanged) {
              await this.approvalService.supersedeLegacyDowngrade(
                request, currentUser[securityId], transaction,
              );
            }
          }
          if (!downgrade) return undefined;
          return this.approvalService.createRequest({
            type: ApprovalRequestType.ORDER_ITEMS_DOWNGRADE,
            entityType: 'order', entityId: id,
            requestedBy: currentUser[securityId],
            requestReason: downgrade.requestReason,
            metadata: {
              removedLines: downgrade.removedLines,
              removedAddons: downgrade.removedAddons,
              _appliedAtRequest: true,
            },
          }, transaction);
        },
      },
    )) as {
      approvalRequest?: Awaited<ReturnType<ApprovalService['createRequest']>>;
      [key: string]: unknown;
    };

    if (result.approvalRequest) {
      this.approvalService.notifyApprovalRequired(
        result.approvalRequest, result.approvalRequest.requestReason,
      );
    }
    return result;
  }

  // ─── Reprocess after delivery ─────────────────────────────────────────────

  @authenticate('jwt')
  @get('/reprocess-reasons')
  @response(200, {
    description: 'Reason options and the claim window, for the reprocess form',
  })
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
  // A delivered item needs a redo: create the free ticket and an audit request together.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{id}/reprocess-request')
  @response(200, {description: 'Reprocess request recorded and free ticket created'})
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
              remarks: {
                type: 'string',
                description: 'Required when reason is "other"',
              },
              mediaIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
              },
              garmentIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description: 'Pieces to redo. Omit to send the whole order.',
              },
              contactChannel: {
                type: 'string',
                enum: ['in_store', 'phone', 'whatsapp', 'other'],
                description:
                  'How the customer got in touch. The free ticket is created immediately. ' +
                  'In-store pieces can begin processing; other channels need a pickup first.',
              },
              deliveryDate: {type: 'string', format: 'date-time'},
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
      deliveryDate?: string;
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
      deliveryDate: body.deliveryDate,
    });
  }

  // ─── Counter Inspection ───────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/inspection/complete')
  @response(200, {
    description:
      'All items inspected at the counter — order moved to processing',
  })
  async completeCounterInspection(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    return this.orderService.completeCounterInspection(
      id,
      currentUser[securityId],
    );
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/inspection/mark')
  @response(200, {
    description: 'Record which units were inspected at the counter',
  })
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
                description:
                  'Units inspected at the counter, identified by line and position',
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
    return this.orderService.markUnitsInspected(
      id,
      body.units,
      currentUser[securityId],
    );
  }

  // ─── Split Order ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/{id}/split')
  @response(200, {
    description:
      'Split ready garments into a new sub-order dispatched immediately',
  })
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
              deliveryDate: {
                type: 'string',
                format: 'date-time',
                description: 'New delivery date for the sub-order',
              },
              deliveryType: {
                type: 'string',
                enum: Object.values(DeliveryType),
                description: 'Legacy field; ignored for split pricing.',
              },
              applyDeliveryCharges: {
                type: 'boolean',
                description:
                  'Set false to keep the original tier when splitting through inspection.',
              },
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      garmentIds: string[];
      deliveryDate?: string;
      deliveryType?: DeliveryType;
      applyDeliveryCharges?: boolean;
      remarks?: string;
    },
  ): Promise<object> {
    return this.orderService.splitOrder(
      id,
      body.garmentIds,
      body.deliveryDate,
      body.applyDeliveryCharges,
      body.remarks,
      currentUser[securityId],
    );
  }

  // ─── Wallet full-payment discount preview ──────────────────────────────────
  // Read-only — tells the UI what a full-wallet payment would actually cost
  // before the customer commits, since addPayment() needs the discounted
  // amount sent up front (it can't retroactively shrink an over-amount
  // wallet request). See OrderService.previewWalletFullPaymentDiscount().

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{id}/wallet-full-payment-preview')
  @response(200, {
    description:
      'Whether paying this order fully via wallet right now would get a discount',
  })
  async walletFullPaymentPreview(
    @param.path.string('id') id: string,
  ): Promise<object> {
    return this.orderService.previewWalletFullPaymentDiscount(id);
  }

  // Same preview, before an order exists yet — the New Order/POS screen
  // already tracks its own live subtotal/discount for display, so it
  // sends those directly rather than the backend re-deriving them from a
  // cart it doesn't otherwise need to see. Gated on the discount AMOUNT,
  // not a type string — see resolveWalletFullPaymentDiscount()'s comment
  // for why (a discount group can tag discountType without any real
  // rupee effect).
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:create']})
  @post('/orders/wallet-full-payment-preview')
  @response(200, {
    description:
      'Whether paying a new ticket fully via wallet would get a discount',
  })
  async walletFullPaymentPreviewForNewOrder(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['subtotal'],
            properties: {
              subtotal: {type: 'number'},
              discountAmount: {type: 'number'},
            },
          },
        },
      },
    })
    body: {
      subtotal: number;
      discountAmount?: number;
    },
  ): Promise<object> {
    return this.orderService.previewWalletFullPaymentDiscountForNewOrder(
      Number(body.subtotal ?? 0),
      Number(body.discountAmount ?? 0),
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
    await this.storeScopeService.assertOrderVisible(id, currentUser);
    if (!body.payment && !body.walletAmount) {
      throw new HttpErrors.BadRequest(
        'Provide at least one of payment or walletAmount.',
      );
    }
    const result = (await this.orderService.addPayment(
      id,
      body.payment!,
      Number(body.walletAmount ?? 0),
      currentUser[securityId],
    )) as {
      pendingApproval: {
        amount: number;
        paymentMode: PaymentMode;
        transactionReference?: string;
      } | null;
    };
    const approvalRequest = result.pendingApproval
      ? await this._createPendingPaymentApprovalRequest(
          id,
          result.pendingApproval,
          currentUser[securityId],
        )
      : null;
    return {...result, approvalRequest};
  }

  // ─── In-store Handover (counter pickup) ────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{id}/handover')
  @response(200, {
    description: 'Order handed over in store and marked delivered',
  })
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
              collectorType: {
                type: 'string',
                enum: Object.values(HandoverCollectorType),
              },
              // Required when collectorType = 'contact'
              customerContactId: {type: 'string', format: 'uuid'},
              // Required when collectorType = 'family_member'
              familyGroupMemberId: {type: 'string', format: 'uuid'},
              // Required when collectorType = 'other'; snapshot for the others
              collectorName: {type: 'string'},
              collectorPhone: {type: 'string'},
              collectorRelationship: {
                type: 'string',
                enum: Object.values(ContactRelationship),
              },
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
  @response(200, {
    description: 'Handover record for an order (null if not handed over)',
  })
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
    const order = await this.orderRepository.findOne({
      where: {id, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const details = await this.orderService.getOrderDetails(id);
    const {paymentTransactions, totalCollected, balanceDue} = details as any;
    return {
      paymentTransactions,
      totalCollected,
      balanceDue,
      totalAmount: order.totalAmount,
    };
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
              reason: {
                type: 'string',
                description: 'Required — why this payment is being corrected.',
              },
            },
          },
        },
      },
    })
    body: {paymentMode: PaymentMode; reason: string},
  ): Promise<object> {
    const userLabel = currentUser as {name?: string; email?: string};
    const performedByLabel =
      userLabel.name ?? userLabel.email ?? currentUser[securityId];
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
  @response(200, {
    description: 'Unified activity log for an order and its garments',
  })
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
    const order = await this.orderRepository.findOne({
      where: {id, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.RETURNED
    ) {
      throw new HttpErrors.BadRequest(
        'Cannot delete a delivered or returned order.',
      );
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
