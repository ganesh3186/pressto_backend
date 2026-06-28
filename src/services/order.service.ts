import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PresstoDataSource} from '../datasources';
import {PaymentMode} from '../models/payment-mode.enum';
import {ReferenceType} from '../models/reference-type.enum';
import {OrderStatus, ORDER_STATUS_TRANSITIONS} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {WalletTransactionType} from '../models/wallet-transaction-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import {
  AdditionalChargeMasterRepository,
  ClusterPriceListRepository,
  ClusterRepository,
  CustomerRepository,
  GarmentRepository,
  GarmentStatusHistoryRepository,
  OrderAdditionalChargeRepository,
  OrderItemAdditionalChargeRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PaymentTransactionRepository,
  PriceListRepository,
  ServiceItemMappingRepository,
  StoreRepository,
  StorePriceOverrideRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';

export interface OrderPaymentInput {
  paymentMode: PaymentMode;
  amount: number;
  transactionReference?: string;
  gatewayResponse?: string;
}

export interface CreateOrderItemInput {
  serviceId: string;
  itemId: string;
  quantity: number;
  specialInstructions?: string;
  specialInstructionMediaIds?: string[];
  remarks?: string;
  additionalChargeIds?: string[];
}

export interface CreateOrderInput {
  customerId: string;
  storeId: string;
  orderType: OrderType;
  items: CreateOrderItemInput[];
  additionalChargeIds?: string[];
  specialInstructions?: string;
  specialInstructionMediaIds?: string[];
  remarks?: string;
  deliveryDate?: Date;
  payments?: OrderPaymentInput[];
  walletAmount?: number;
}

@injectable({scope: BindingScope.TRANSIENT})
export class OrderService {
  constructor(
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderAdditionalChargeRepository) private orderChargeRepo: OrderAdditionalChargeRepository,
    @repository(OrderItemAdditionalChargeRepository) private orderItemChargeRepo: OrderItemAdditionalChargeRepository,
    @repository(OrderStatusHistoryRepository) private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(PaymentTransactionRepository) private paymentTransactionRepo: PaymentTransactionRepository,
    @repository(WalletRepository) private walletRepo: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepo: WalletTransactionRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
    @repository(ClusterPriceListRepository) private clusterPriceListRepo: ClusterPriceListRepository,
    @repository(PriceListRepository) private priceListRepo: PriceListRepository,
    @repository(StorePriceOverrideRepository) private storePriceOverrideRepo: StorePriceOverrideRepository,
    @repository(ServiceItemMappingRepository) private serviceItemMappingRepo: ServiceItemMappingRepository,
    @repository(AdditionalChargeMasterRepository) private additionalChargeRepo: AdditionalChargeMasterRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  // ─── Pricing ──────────────────────────────────────────────────────────────

  private async getUnitPrice(storeId: string, serviceId: string, itemId: string): Promise<number> {
    // Base price from service-item mapping (required)
    const mapping = await this.serviceItemMappingRepo.findOne({where: {serviceId, itemId}});
    if (mapping?.basePrice == null) {
      throw new HttpErrors.BadRequest(
        `No base price configured for serviceId: ${serviceId}, itemId: ${itemId}. Add a ServiceItemMapping with a base price.`,
      );
    }
    const base = Number(mapping.basePrice);

    // 1. Store-specific override percentage
    const override = await this.storePriceOverrideRepo.findOne({
      where: {storeId, isActive: true, isDeleted: false},
    });
    if (override?.percentage != null) return base * (Number(override.percentage) / 100);

    // 2. Cluster price list percentage
    const store = await this.storeRepo.findById(storeId);
    if (store.clusterId) {
      const clusterPriceList = await this.clusterPriceListRepo.findOne({
        where: {clusterId: store.clusterId, isActive: true, isDeleted: false},
      });
      if (clusterPriceList?.percentage != null) return base * (Number(clusterPriceList.percentage) / 100);

      // 3. Region price list percentage
      const cluster = await this.clusterRepo.findById(store.clusterId);
      if (cluster.regionId) {
        const priceList = await this.priceListRepo.findOne({
          where: {regionId: cluster.regionId, isActive: true, isDeleted: false},
        });
        if (priceList?.percentage != null) return base * (Number(priceList.percentage) / 100);
      }
    }

    // 4. Return base price as-is
    return base;
  }

  private applyCustomerDiscount(
    subtotal: number,
    discountType?: string,
    discountValue?: number,
  ): {discountAmount: number; discountType: string} {
    if (!discountType || !discountValue || discountValue === 0) {
      return {discountAmount: 0, discountType: 'none'};
    }
    if (discountType === 'percentage') {
      return {
        discountAmount: Math.round(((subtotal * discountValue) / 100) * 100) / 100,
        discountType: 'percentage',
      };
    }
    if (discountType === 'fixed') {
      return {discountAmount: Math.min(discountValue, subtotal), discountType: 'fixed'};
    }
    return {discountAmount: 0, discountType: 'none'};
  }

  // ─── Create Order ─────────────────────────────────────────────────────────

  async createOrder(input: CreateOrderInput, createdBy: string): Promise<object> {
    const {v4} = await import('uuid');

    const customer = await this.customerRepo.findOne({
      where: {id: input.customerId, isDeleted: false},
    });
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const store = await this.storeRepo.findOne({
      where: {id: input.storeId, isDeleted: false},
    });
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    if (!input.items?.length) {
      throw new HttpErrors.BadRequest('Order must have at least one item.');
    }

    // ── Validate wallet deduction before starting transaction ──
    const walletAmount = Number(input.walletAmount ?? 0);
    let wallet: {id: string; currentBalance: number} | null = null;

    if (walletAmount > 0) {
      const found = await this.walletRepo.findOne({
        where: {customerId: input.customerId, isDeleted: false},
      });
      if (!found) throw new HttpErrors.NotFound('Customer wallet not found.');
      if (Number(found.currentBalance) < walletAmount) {
        throw new HttpErrors.BadRequest(
          `Insufficient wallet balance. Available: ₹${found.currentBalance}, Requested: ₹${walletAmount}`,
        );
      }
      wallet = {id: found.id, currentBalance: Number(found.currentBalance)};
    }

    // ── Pricing ──
    const count = await this.orderRepo.count();
    const orderNumber = `ORD${String(count.count + 1).padStart(6, '0')}`;

    const itemPricings: Array<{
      serviceId: string;
      itemId: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      specialInstructions?: string;
      specialInstructionMediaIds?: string[];
      remarks?: string;
      additionalChargeIds?: string[];
      additionalChargesTotal: number;
    }> = [];

    for (const item of input.items) {
      const unitPrice = await this.getUnitPrice(input.storeId, item.serviceId, item.itemId);
      const totalPrice = unitPrice * item.quantity;

      let additionalChargesTotal = 0;
      for (const chargeId of item.additionalChargeIds ?? []) {
        const charge = await this.additionalChargeRepo.findById(chargeId);
        additionalChargesTotal += Number(charge.defaultAmount);
      }

      itemPricings.push({...item, unitPrice, totalPrice, additionalChargesTotal});
    }

    const orderChargeDetails: Array<{id: string; amount: number}> = [];
    let orderChargesTotal = 0;
    for (const chargeId of input.additionalChargeIds ?? []) {
      const charge = await this.additionalChargeRepo.findById(chargeId);
      const amount = Number(charge.defaultAmount);
      orderChargesTotal += amount;
      orderChargeDetails.push({id: chargeId, amount});
    }

    const itemsSubtotal = itemPricings.reduce((s, i) => s + i.totalPrice + i.additionalChargesTotal, 0);
    const subtotal = itemsSubtotal + orderChargesTotal;

    const {discountAmount, discountType} = this.applyCustomerDiscount(
      subtotal,
      customer.defaultDiscountType,
      customer.defaultDiscountValue ? Number(customer.defaultDiscountValue) : 0,
    );

    const taxAmount = 0; // GST calculated at invoice generation (Phase 3)
    const totalAmount = subtotal - discountAmount + taxAmount;

    // Validate that payment amounts don't exceed total
    const paymentsTotal = (input.payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
    const totalCollected = paymentsTotal + walletAmount;
    if (totalCollected > totalAmount) {
      throw new HttpErrors.BadRequest(
        `Total collected (₹${totalCollected}) exceeds order total (₹${totalAmount}).`,
      );
    }

    // ── Transaction ──
    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED' as any,
    });

    try {
      // Determine initial status before creating the order record
      const isStoreDropoffOrder =
        input.orderType === OrderType.STORE_DROPOFF ||
        input.orderType === OrderType.STORE_DROPOFF_HOME_DELIVERY;
      const orderInitialStatus = isStoreDropoffOrder
        ? OrderStatus.RECEIVED_AT_STORE
        : OrderStatus.CONFIRMED;

      const order = await this.orderRepo.create(
        {
          orderNumber,
          customerId: input.customerId,
          storeId: input.storeId,
          orderType: input.orderType,
          status: orderInitialStatus,
          deliveryDate: input.deliveryDate,
          subtotal,
          discountAmount,
          discountType,
          taxAmount,
          totalAmount,
          specialInstructions: input.specialInstructions,
          specialInstructionMediaIds: input.specialInstructionMediaIds,
          remarks: input.remarks,
        },
        {transaction: tx},
      );

      // Order items + item-level charges
      const createdItems = [];
      for (const item of itemPricings) {
        const orderItem = await this.orderItemRepo.create(
          {
            orderId: order.id,
            serviceId: item.serviceId,
            itemId: item.itemId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            specialInstructions: item.specialInstructions,
            specialInstructionMediaIds: item.specialInstructionMediaIds,
            remarks: item.remarks,
          },
          {transaction: tx},
        );

        for (const chargeId of item.additionalChargeIds ?? []) {
          const charge = await this.additionalChargeRepo.findById(chargeId);
          await this.orderItemChargeRepo.create(
            {orderItemId: orderItem.id, additionalChargeId: chargeId, amount: Number(charge.defaultAmount)},
            {transaction: tx},
          );
        }

        createdItems.push(orderItem);
      }

      // Order-level charges
      for (const {id: chargeId, amount} of orderChargeDetails) {
        await this.orderChargeRepo.create(
          {orderId: order.id, additionalChargeId: chargeId, amount},
          {transaction: tx},
        );
      }

      // Initial status history
      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId: order.id,
          status: orderInitialStatus,
          changedAt: new Date(),
          changedBy: createdBy,
          remarks: 'Order created',
        },
        {transaction: tx},
      );

      // Auto-create garments for store drop-off (customer is physically present)
      const createdGarments: object[] = [];
      if (isStoreDropoffOrder) {
        const now = new Date();
        for (const orderItem of createdItems) {
          for (let i = 0; i < orderItem.quantity; i++) {
            const garmentCount = await this.garmentRepo.count();
            const garmentTagNumber = `GT${String(garmentCount.count + 1).padStart(8, '0')}`;

            const garment = await this.garmentRepo.create(
              {orderItemId: orderItem.id, garmentTagNumber, status: GarmentStatus.RECEIVED},
              {transaction: tx},
            );

            await this.garmentStatusHistoryRepo.create(
              {
                id: v4(),
                garmentId: garment.id,
                status: GarmentStatus.RECEIVED,
                changedAt: now,
                changedBy: createdBy,
                remarks: 'Received at store with order',
              },
              {transaction: tx},
            );

            createdGarments.push(garment);
          }
        }
      }

      // Payment transactions (cash / card / UPI etc.)
      const createdPayments = [];
      for (const payment of input.payments ?? []) {
        const pt = await this.paymentTransactionRepo.create(
          {
            orderId: order.id,
            paymentMode: payment.paymentMode,
            amount: payment.amount,
            transactionReference: payment.transactionReference,
            gatewayResponse: payment.gatewayResponse,
            paymentDate: new Date(),
          },
          {transaction: tx},
        );
        createdPayments.push(pt);
      }

      // Wallet deduction
      if (walletAmount > 0 && wallet) {
        const newBalance = wallet.currentBalance - walletAmount;
        await this.walletRepo.updateById(
          wallet.id,
          {currentBalance: newBalance},
          {transaction: tx},
        );
        await this.walletTransactionRepo.create(
          {
            id: v4(),
            walletId: wallet.id,
            transactionType: WalletTransactionType.DEBIT,
            amount: walletAmount,
            referenceType: ReferenceType.ORDER,
            referenceId: order.id,
            remarks: `Deducted for order ${orderNumber}`,
            transactionDate: new Date(),
          },
          {transaction: tx},
        );
      }

      await tx.commit();

      return {
        order: {...order, status: orderInitialStatus},
        items: createdItems,
        garments: createdGarments,
        payments: createdPayments,
        walletAmountDeducted: walletAmount,
        totalCollected,
        balanceDue: Math.max(0, totalAmount - totalCollected),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ─── Status Transition ────────────────────────────────────────────────────

  async changeStatus(
    orderId: string,
    newStatus: OrderStatus,
    changedBy: string,
    remarks?: string,
  ): Promise<object> {
    const {v4} = await import('uuid');
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const allowed = ORDER_STATUS_TRANSITIONS[order.status!];
    if (!allowed.includes(newStatus)) {
      throw new HttpErrors.BadRequest(
        `Cannot move order from '${order.status}' to '${newStatus}'. Allowed: [${allowed.join(', ')}]`,
      );
    }

    await this.orderRepo.updateById(orderId, {status: newStatus});
    await this.statusHistoryRepo.create({
      id: v4(),
      orderId,
      status: newStatus,
      changedAt: new Date(),
      changedBy,
      remarks,
    });

    // Auto-create garments when order is received at store
    if (newStatus === OrderStatus.RECEIVED_AT_STORE) {
      const garments = await this.autoCreateGarments(orderId, changedBy, v4);
      return {garments};
    }

    return {};
  }

  private async autoCreateGarments(
    orderId: string,
    changedBy: string,
    v4: () => string,
  ): Promise<object[]> {
    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const now = new Date();
    const created: object[] = [];

    for (const item of orderItems) {
      // Check how many garments already exist (idempotent — skip if already created)
      const existing = await this.garmentRepo.count({orderItemId: item.id, isDeleted: false});
      const toCreate = item.quantity - existing.count;
      if (toCreate <= 0) continue;

      for (let i = 0; i < toCreate; i++) {
        const totalCount = await this.garmentRepo.count();
        const garmentTagNumber = `GT${String(totalCount.count + 1).padStart(8, '0')}`;

        const garment = await this.garmentRepo.create({
          orderItemId: item.id,
          garmentTagNumber,
          status: GarmentStatus.RECEIVED,
        });

        await this.garmentStatusHistoryRepo.create({
          id: v4(),
          garmentId: garment.id,
          status: GarmentStatus.RECEIVED,
          changedAt: now,
          changedBy,
          remarks: 'Auto-created on order receive',
        });

        created.push(garment);
      }
    }

    return created;
  }

  // ─── Get Order Details ────────────────────────────────────────────────────

  async getOrderDetails(orderId: string): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const [items, orderCharges, statusHistory, paymentTransactions] = await Promise.all([
      this.orderItemRepo.find({where: {orderId}}),
      this.orderChargeRepo.find({where: {orderId}}),
      this.statusHistoryRepo.find({where: {orderId}, order: ['changedAt DESC']}),
      this.paymentTransactionRepo.find({where: {orderId}}),
    ]);

    const itemsWithCharges = await Promise.all(
      items.map(async item => {
        const charges = await this.orderItemChargeRepo.find({where: {orderItemId: item.id}});
        return {...item, additionalCharges: charges};
      }),
    );

    const totalCollected = paymentTransactions.reduce((s, p) => s + Number(p.amount), 0);
    const balanceDue = Math.max(0, Number(order.totalAmount) - totalCollected);

    return {
      order,
      items: itemsWithCharges,
      orderCharges,
      statusHistory,
      paymentTransactions,
      totalCollected,
      balanceDue,
    };
  }

  // ─── Add Payment to Existing Order ───────────────────────────────────────

  async addPayment(
    orderId: string,
    payment: OrderPaymentInput,
    walletAmount: number,
    performedBy: string,
  ): Promise<object> {
    const {v4} = await import('uuid');
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.CANCELLED) {
      throw new HttpErrors.BadRequest('Cannot add payment to a cancelled order.');
    }

    // Check how much is still due
    const existing = await this.paymentTransactionRepo.find({where: {orderId}});
    const alreadyPaid = existing.reduce((s, p) => s + Number(p.amount), 0);
    const due = Math.max(0, Number(order.totalAmount) - alreadyPaid);

    const thisPayment = Number(payment?.amount ?? 0);
    const thisWallet = Number(walletAmount ?? 0);
    const thisTotal = thisPayment + thisWallet;

    if (thisTotal > due) {
      throw new HttpErrors.BadRequest(
        `Payment amount ₹${thisTotal} exceeds balance due ₹${due}.`,
      );
    }

    let wallet: {id: string; currentBalance: number} | null = null;
    if (thisWallet > 0) {
      const found = await this.walletRepo.findOne({
        where: {customerId: order.customerId, isDeleted: false},
      });
      if (!found) throw new HttpErrors.NotFound('Customer wallet not found.');
      if (Number(found.currentBalance) < thisWallet) {
        throw new HttpErrors.BadRequest(
          `Insufficient wallet balance. Available: ₹${found.currentBalance}, Requested: ₹${thisWallet}`,
        );
      }
      wallet = {id: found.id, currentBalance: Number(found.currentBalance)};
    }

    const tx = await this.dataSource.beginTransaction({
      isolationLevel: 'READ COMMITTED' as any,
    });
    try {
      let createdPayment = null;
      if (thisPayment > 0 && payment) {
        createdPayment = await this.paymentTransactionRepo.create(
          {
            orderId,
            paymentMode: payment.paymentMode,
            amount: thisPayment,
            transactionReference: payment.transactionReference,
            gatewayResponse: payment.gatewayResponse,
            paymentDate: new Date(),
          },
          {transaction: tx},
        );
      }

      if (thisWallet > 0 && wallet) {
        const newBalance = wallet.currentBalance - thisWallet;
        await this.walletRepo.updateById(wallet.id, {currentBalance: newBalance}, {transaction: tx});
        await this.walletTransactionRepo.create(
          {
            id: v4(),
            walletId: wallet.id,
            transactionType: WalletTransactionType.DEBIT,
            amount: thisWallet,
            referenceType: ReferenceType.ORDER,
            referenceId: orderId,
            remarks: `Payment for order ${order.orderNumber}`,
            transactionDate: new Date(),
          },
          {transaction: tx},
        );
      }

      await tx.commit();

      const newPaid = alreadyPaid + thisTotal;
      return {
        message: 'Payment recorded.',
        payment: createdPayment,
        walletAmountDeducted: thisWallet,
        totalCollected: newPaid,
        balanceDue: Math.max(0, Number(order.totalAmount) - newPaid),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}
