import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
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
import {PaymentMode} from '../models/payment-mode.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {HandoverCollectorType} from '../models/order-handover.model';
import {
  OrderLabelAssignmentRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
} from '../repositories';
import {DeliveryType} from '../models/delivery-type.enum';
import {
  REPROCESS_REASON_LABELS,
  ReprocessReason,
  reprocessWindowDays,
} from '../models/reprocess-reason.enum';
import {CreateOrderInput, OrderPaymentInput, OrderService} from '../services/order.service';
import {ReprocessService} from '../services/reprocess.service';
import {StoreScopeService} from '../services/store-scope.service';

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
    additionalChargeIds: {type: 'array' as const, items: {type: 'string' as const, format: 'uuid'}},
    additionalServiceIds: {type: 'array' as const, items: {type: 'string' as const, format: 'uuid'}, description: 'Additional services selected for this item'},
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
  ) {}


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
              additionalChargeIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
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
    const result = await this.orderService.createOrder(body, createdBy);
    return {message: 'Order created successfully.', ...result};
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
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {
      storeId: storeIdFilter,
      clusterId: clusterIdFilter,
    });
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
    });
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

    const {orderLabelIds, ...orderFields} = body;
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
                    additionalChargeIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
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
        additionalChargeIds?: string[];
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
    return this.orderService.addPayment(
      id,
      body.payment!,
      Number(body.walletAmount ?? 0),
      currentUser[securityId],
    );
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
