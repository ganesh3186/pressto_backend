import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, repository} from '@loopback/repository';
import {
  del,
  get,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PaymentMode} from '../models/payment-mode.enum';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {Order} from '../models/order.model';
import {OrderItemRepository, OrderRepository, OrderStatusHistoryRepository} from '../repositories';
import {CreateOrderInput, OrderPaymentInput, OrderService} from '../services/order.service';

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
  },
};

export class OrderController {
  constructor(
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(OrderItemRepository)
    private orderItemRepository: OrderItemRepository,
    @repository(OrderStatusHistoryRepository)
    private statusHistoryRepository: OrderStatusHistoryRepository,
    @inject('services.order')
    private orderService: OrderService,
  ) {}

  // ─── Create Order ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
              expressMultiplier: {
                type: 'number',
                minimum: 1,
                description: 'Urgency multiplier (1 = standard, 2 = 2x faster/costlier). Backend calculates deliveryDate from this.',
              },
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {type: 'array', items: {type: 'string'}},
              remarks: {type: 'string'},
              additionalChargeIds: {type: 'array', items: {type: 'string', format: 'uuid'}},
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

  // ─── List Orders ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/orders')
  @response(200, {description: 'List of orders'})
  async find(@param.filter(Order) filter?: Filter<Order>): Promise<Order[]> {
    return this.orderRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, (filter?.where ?? {}) as object]},
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/orders/{id}')
  @response(200, {description: 'Order with items, charges, payments and status history'})
  async findById(@param.path.string('id') id: string): Promise<object> {
    return this.orderService.getOrderDetails(id);
  }

  // ─── Update Order Metadata ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
    },
  ): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED) {
      throw new HttpErrors.BadRequest('Cannot update a delivered or cancelled order.');
    }
    await this.orderRepository.updateById(id, body);
    return {message: 'Order updated.'};
  }

  // ─── Change Status ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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

  // ─── Add Payment to Existing Order ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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

  // ─── Get Payment History ──────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
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
  @authorize({roles: ['super_admin']})
  @del('/orders/{id}')
  @response(200, {description: 'Order cancelled and soft-deleted'})
  async deleteById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const order = await this.orderRepository.findOne({where: {id, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.DELIVERED) {
      throw new HttpErrors.BadRequest('Cannot delete a delivered order.');
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
