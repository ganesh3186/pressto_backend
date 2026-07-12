import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {Customer} from '../models';
import {Order} from '../models/order.model';
import {OrderStatus} from '../models/order-status.enum';
import {
  ChallanRepository,
  CustomerRepository,
  InvoiceRepository,
  OrderRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';
import {OrderService} from '../services/order.service';

// Customer-friendly labels for the raw order status values.
const ORDER_STATUS_LABEL: Record<string, string> = {
  [OrderStatus.DRAFT]: 'Draft',
  [OrderStatus.CONFIRMED]: 'Confirmed',
  [OrderStatus.RECEIVED_AT_STORE]: 'Received at store',
  [OrderStatus.IN_INSPECTION]: 'Inspection',
  [OrderStatus.IN_PROCESS]: 'In process',
  [OrderStatus.QUALITY_CHECK]: 'Quality check',
  [OrderStatus.READY]: 'Ready',
  [OrderStatus.OUT_FOR_DELIVERY]: 'Out for delivery',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.CANCELLED]: 'Cancelled',
  [OrderStatus.ON_HOLD]: 'On hold',
};

// The stages a customer sees on the tracking screen, in order.
const TRACKING_STEPS: Array<{key: string; label: string; status: OrderStatus}> = [
  {key: 'placed', label: 'Order placed', status: OrderStatus.CONFIRMED},
  {key: 'received', label: 'Received at store', status: OrderStatus.RECEIVED_AT_STORE},
  {key: 'inspection', label: 'Inspection', status: OrderStatus.IN_INSPECTION},
  {key: 'processing', label: 'In process', status: OrderStatus.IN_PROCESS},
  {key: 'quality_check', label: 'Quality check', status: OrderStatus.QUALITY_CHECK},
  {key: 'ready', label: 'Ready', status: OrderStatus.READY},
  {key: 'out_for_delivery', label: 'Out for delivery', status: OrderStatus.OUT_FOR_DELIVERY},
  {key: 'delivered', label: 'Delivered', status: OrderStatus.DELIVERED},
];

/**
 * Customer-facing (self-service) APIs.
 *
 * Every route is READ-ONLY and scoped to the logged-in customer: the customer id
 * is derived from the JWT (securityId → users.id → customer.userId), never from
 * a client-supplied parameter. Order creation / updates stay admin-only.
 */
export class CustomerOrderController {
  constructor(
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @inject('services.order') private orderService: OrderService,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Resolve the Customer row that owns the JWT's user. */
  private async resolveCustomer(currentUser: UserProfile): Promise<Customer> {
    const userId = currentUser[securityId];
    const customer = await this.customerRepo.findOne({where: {userId, isDeleted: false}});
    if (!customer) {
      throw new HttpErrors.NotFound('Customer profile not found for this user.');
    }
    return customer;
  }

  /** Load an order and hard-fail if it does not belong to this customer. */
  private async resolveOwnedOrder(orderId: string, customerId: string): Promise<Order> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.customerId !== customerId) {
      throw new HttpErrors.Forbidden('You do not have access to this order.');
    }
    return order;
  }

  // ─── Orders: summary (declared before /{orderId} so the static path wins) ───

  @authenticate('jwt')
  @get('/profile/customer/orders/summary')
  @response(200, {description: "Counts of the customer's orders by status"})
  async ordersSummary(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);

    const orders = await this.orderRepo.find({
      where: {customerId: customer.id, isDeleted: false},
      fields: {id: true, status: true, totalAmount: true} as any,
    });

    const byStatus: Record<string, number> = {};
    for (const o of orders) {
      const key = String(o.status);
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }

    const active = orders.filter(
      o => o.status !== OrderStatus.DELIVERED && o.status !== OrderStatus.CANCELLED,
    ).length;

    return {
      total: orders.length,
      active,
      delivered: byStatus[OrderStatus.DELIVERED] ?? 0,
      cancelled: byStatus[OrderStatus.CANCELLED] ?? 0,
      byStatus,
    };
  }

  // ─── Orders: list ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders')
  @response(200, {description: "The logged-in customer's orders (paginated)"})
  async listMyOrders(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('search') search?: string,
    @param.query.string('status') status?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);

    // customerId is forced from the JWT — a client cannot widen the scope.
    return this.orderService.listOrders({
      customerId: customer.id,
      search,
      status,
      dateFrom,
      dateTo,
      limit,
      skip,
    });
  }

  // ─── Orders: details ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}')
  @response(200, {description: 'Full order details (items, garments, payments)'})
  async myOrderDetails(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    await this.resolveOwnedOrder(orderId, customer.id);

    return this.orderService.getOrderDetails(orderId);
  }

  // ─── Orders: status tracking ───────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/tracking')
  @response(200, {description: 'Status timeline + per-garment progress for an order'})
  async myOrderTracking(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    await this.resolveOwnedOrder(orderId, customer.id);

    const details = (await this.orderService.getOrderDetails(orderId)) as any;
    const order = details.order ?? {};
    const items = Array.isArray(details.items) ? details.items : [];
    const history = Array.isArray(details.statusHistory) ? details.statusHistory : [];

    // When each status was reached (first occurrence wins).
    const reachedAt = new Map<string, string>();
    for (const h of history) {
      if (h?.status && !reachedAt.has(h.status)) reachedAt.set(h.status, h.changedAt);
    }

    const isCancelled = order.status === OrderStatus.CANCELLED;
    const currentIndex = TRACKING_STEPS.findIndex(s => s.status === order.status);

    const steps = TRACKING_STEPS.map((step, idx) => {
      const at = reachedAt.get(step.status) ?? null;
      const done = Boolean(at) || (currentIndex > -1 && idx < currentIndex);
      return {
        key: step.key,
        label: step.label,
        status: step.status,
        done,
        current: order.status === step.status,
        at,
      };
    });

    // Flatten garments so the customer sees per-piece progress.
    const garments: object[] = [];
    for (const item of items) {
      for (const g of item.garments ?? []) {
        garments.push({
          garmentTagNumber: g.garmentTagNumber,
          itemName: item.itemName,
          serviceName: item.serviceName,
          status: g.status,
          statusLabel: ORDER_STATUS_LABEL[g.status] ?? g.status,
          stages: g.stages ?? null,
        });
      }
    }

    const readyLike = ['ready', 'out_for_delivery', 'delivered'];
    const completed = garments.filter((g: any) => readyLike.includes(g.status)).length;

    return {
      orderId,
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: ORDER_STATUS_LABEL[order.status] ?? order.status,
      isCancelled,
      placedAt: order.createdAt ?? null,
      deliveryDate: order.deliveryDate ?? null,
      steps,
      garments,
      progress: {
        completed,
        total: garments.length,
        percentage: garments.length ? Math.round((completed / garments.length) * 100) : 0,
      },
      timeline: history.map((h: any) => ({
        status: h.status,
        label: ORDER_STATUS_LABEL[h.status] ?? h.status,
        at: h.changedAt,
        remarks: h.remarks ?? null,
      })),
    };
  }

  // ─── Orders: payments ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/payments')
  @response(200, {description: 'Payment history + balance for an order'})
  async myOrderPayments(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    await this.resolveOwnedOrder(orderId, customer.id);

    const details = (await this.orderService.getOrderDetails(orderId)) as any;
    return {
      orderId,
      orderNumber: details.order?.orderNumber,
      totalAmount: details.order?.totalAmount ?? 0,
      totalCollected: details.totalCollected ?? 0,
      balanceDue: details.balanceDue ?? 0,
      paymentTransactions: details.paymentTransactions ?? [],
    };
  }

  // ─── Orders: billing documents ─────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/invoice')
  @response(200, {description: 'Invoice for an order'})
  async myOrderInvoice(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    await this.resolveOwnedOrder(orderId, customer.id);

    const invoice = await this.invoiceRepo.findOne({where: {orderId} as any});
    if (!invoice) throw new HttpErrors.NotFound('No invoice generated for this order yet.');
    return {invoice};
  }

  @authenticate('jwt')
  @get('/profile/customer/orders/{orderId}/challan')
  @response(200, {description: 'Challan for an order'})
  async myOrderChallan(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);
    await this.resolveOwnedOrder(orderId, customer.id);

    const challan = await this.challanRepo.findOne({where: {orderId} as any});
    if (!challan) throw new HttpErrors.NotFound('No challan generated for this order yet.');
    return {challan};
  }

  // ─── Wallet: transactions (paginated) ──────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/wallet/transactions')
  @response(200, {description: "The customer's wallet transactions (paginated)"})
  async myWalletTransactions(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('transactionType') transactionType?: string,
    @param.query.number('limit') limit?: number,
    @param.query.number('skip') skip?: number,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser);

    const wallet = await this.walletRepo.findOne({where: {customerId: customer.id}});
    if (!wallet) {
      return {currentBalance: 0, rows: [], total: 0};
    }

    const take = Math.min(Number(limit ?? 20), 100);
    const offset = Number(skip ?? 0);

    const where: Record<string, unknown> = {walletId: wallet.id, isDeleted: false};
    if (transactionType) where.transactionType = transactionType;

    const [rows, count] = await Promise.all([
      this.walletTransactionRepo.find({
        where: where as any,
        order: ['transactionDate DESC'],
        limit: take,
        skip: offset,
      }),
      this.walletTransactionRepo.count(where as any),
    ]);

    return {
      walletId: wallet.id,
      currentBalance: Number(wallet.currentBalance) || 0,
      rows,
      total: count.count,
      limit: take,
      skip: offset,
    };
  }
}
