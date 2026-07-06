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
  CustomerContactRepository,
  CustomerRepository,
  DeliveryTypeConfigurationRepository,
  ItemRepository,
  ServiceRepository,
  UsersRepository,
  GarmentDamageImageRepository,
  GarmentDamageRepository,
  GarmentImageRepository,
  GarmentRepository,
  GarmentStainImageRepository,
  GarmentStainRepository,
  GarmentStatusHistoryRepository,
  GstTaxConfigurationRepository,
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
import {DeliveryType} from '../models/delivery-type.enum';
import {GarmentImageType} from '../models/garment-image-type.enum';

export interface OrderPaymentInput {
  paymentMode: PaymentMode;
  amount: number;
  transactionReference?: string;
  gatewayResponse?: string;
}

export interface UnitStainMarkInput {
  stainId: string;
  remarks?: string;
  mediaIds?: string[];   // already-uploaded Media record IDs
}

export interface UnitDamageMarkInput {
  damageId: string;
  remarks?: string;
  mediaIds?: string[];   // already-uploaded Media record IDs
}

export interface UnitInspectionInput {
  brandId?: string;
  colorId?: string;
  additionalChargeIds?: string[];   // add-ons + requirements for this specific unit
  stainMarks?: UnitStainMarkInput[];
  damageMarks?: UnitDamageMarkInput[];
  itemPhotoMediaIds?: string[];     // already-uploaded Media record IDs
  instructions?: string;            // stored as customerRemarks on Garment
  qrPrintCount?: number;
}

export interface CreateOrderItemInput {
  serviceId: string;
  itemId: string;
  quantity: number;
  specialInstructions?: string;
  specialInstructionMediaIds?: string[];
  remarks?: string;
  additionalChargeIds?: string[];   // line-level charges (billing)
  additionalServiceIds?: string[];  // additional services selected for this item
  units?: UnitInspectionInput[];    // per-garment inspection data (length must match quantity)
}

export interface CreateOrderInput {
  customerId: string;
  storeId: string;
  orderType: OrderType;
  items: CreateOrderItemInput[];
  isDraft?: boolean;
  deliveryType?: DeliveryType;      // standard | express | lightning
  additionalChargeIds?: string[];
  customerContactId?: string;       // person who came on behalf of customer
  specialInstructions?: string;
  specialInstructionMediaIds?: string[];
  remarks?: string;
  expressMultiplier?: number;  // 1 = standard, 2 = 2x faster/costlier; backend calculates deliveryDate
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
    @repository(GarmentStainRepository) private garmentStainRepo: GarmentStainRepository,
    @repository(GarmentStainImageRepository) private garmentStainImageRepo: GarmentStainImageRepository,
    @repository(GarmentDamageRepository) private garmentDamageRepo: GarmentDamageRepository,
    @repository(GarmentDamageImageRepository) private garmentDamageImageRepo: GarmentDamageImageRepository,
    @repository(GarmentImageRepository) private garmentImageRepo: GarmentImageRepository,
    @repository(GstTaxConfigurationRepository) private gstConfigRepo: GstTaxConfigurationRepository,
    @repository(DeliveryTypeConfigurationRepository) private deliveryTypeConfigRepo: DeliveryTypeConfigurationRepository,
    @repository(CustomerContactRepository) private customerContactRepo: CustomerContactRepository,
    @repository(UsersRepository) private userRepo: UsersRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
  ) {}

  // ─── Inspection ──────────────────────────────────────────────────────────

  private async saveGarmentInspection(
    garmentId: string,
    unit: UnitInspectionInput,
    tx: any,
    v4: () => string,
  ): Promise<void> {
    // Item-level photos → GarmentImage (imageType: inspection)
    for (const mediaId of unit.itemPhotoMediaIds ?? []) {
      await this.garmentImageRepo.create(
        {id: v4(), garmentId, mediaId, imageType: GarmentImageType.GENERAL},
        {transaction: tx},
      );
    }

    // Stain marks → GarmentStain + GarmentStainImage per photo
    for (const stainMark of unit.stainMarks ?? []) {
      if (!stainMark.stainId) continue;
      const garmentStain = await this.garmentStainRepo.create(
        {id: v4(), garmentId, stainId: stainMark.stainId, remarks: stainMark.remarks},
        {transaction: tx},
      );
      for (const mediaId of stainMark.mediaIds ?? []) {
        await this.garmentStainImageRepo.create(
          {id: v4(), garmentStainId: garmentStain.id, mediaId},
          {transaction: tx},
        );
      }
    }

    // Damage marks → GarmentDamage + GarmentDamageImage per photo
    for (const damageMark of unit.damageMarks ?? []) {
      if (!damageMark.damageId) continue;
      const garmentDamage = await this.garmentDamageRepo.create(
        {id: v4(), garmentId, damageTypeId: damageMark.damageId, remarks: damageMark.remarks},
        {transaction: tx},
      );
      for (const mediaId of damageMark.mediaIds ?? []) {
        await this.garmentDamageImageRepo.create(
          {id: v4(), garmentDamageId: garmentDamage.id, mediaId},
          {transaction: tx},
        );
      }
    }
  }

  // ─── Pricing ──────────────────────────────────────────────────────────────

  private async resolvePricing(
    storeId: string,
    serviceId: string,
    itemId: string,
  ): Promise<{
    basePrice: number;
    resolvedPrice: number;
    appliedPercentage: number | null;
    priceSource: 'store' | 'cluster' | 'region' | 'base';
    estimatedDurationInDays: number | null;
  }> {
    const mapping = await this.serviceItemMappingRepo.findOne({where: {serviceId, itemId}});
    if (mapping?.basePrice == null) {
      throw new HttpErrors.BadRequest(
        `No base price configured for serviceId: ${serviceId}, itemId: ${itemId}.`,
      );
    }
    const base = Number(mapping.basePrice);
    const estimatedDurationInDays = mapping.estimatedDurationInDays ?? null;

    // Priority 1: store override
    const override = await this.storePriceOverrideRepo.findOne({
      where: {storeId, isActive: true, isDeleted: false},
    });
    if (override?.percentage != null) {
      const pct = Number(override.percentage);
      return {basePrice: base, resolvedPrice: base * (pct / 100), appliedPercentage: pct, priceSource: 'store', estimatedDurationInDays};
    }

    // Priority 2: cluster price list
    const store = await this.storeRepo.findById(storeId);
    if (store.clusterId) {
      const clusterPriceList = await this.clusterPriceListRepo.findOne({
        where: {clusterId: store.clusterId, isActive: true, isDeleted: false},
      });
      if (clusterPriceList?.percentage != null) {
        const pct = Number(clusterPriceList.percentage);
        return {basePrice: base, resolvedPrice: base * (pct / 100), appliedPercentage: pct, priceSource: 'cluster', estimatedDurationInDays};
      }

      // Priority 3: region price list
      const cluster = await this.clusterRepo.findById(store.clusterId);
      if (cluster.regionId) {
        const priceList = await this.priceListRepo.findOne({
          where: {regionId: cluster.regionId, isActive: true, isDeleted: false},
        });
        if (priceList?.percentage != null) {
          const pct = Number(priceList.percentage);
          return {basePrice: base, resolvedPrice: base * (pct / 100), appliedPercentage: pct, priceSource: 'region', estimatedDurationInDays};
        }
      }
    }

    // Fallback: base price as-is
    return {basePrice: base, resolvedPrice: base, appliedPercentage: null, priceSource: 'base', estimatedDurationInDays};
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

    // ── Validate customer contact (if provided) ──
    if (input.customerContactId) {
      const contact = await this.customerContactRepo.findOne({
        where: {id: input.customerContactId, customerId: input.customerId, isDeleted: false},
      });
      if (!contact) {
        throw new HttpErrors.NotFound('Customer contact not found or does not belong to this customer.');
      }
    }

    // ── Delivery type percentage ──
    let deliveryTypePercentage = 0;
    if (input.deliveryType) {
      const dtConfig = await this.deliveryTypeConfigRepo.findOne({where: {isDeleted: false}});
      if (dtConfig) {
        if (input.deliveryType === DeliveryType.EXPRESS) {
          deliveryTypePercentage = Number(dtConfig.expressPercentage);
        } else if (input.deliveryType === DeliveryType.LIGHTNING) {
          deliveryTypePercentage = Number(dtConfig.lightningPercentage);
        } else {
          deliveryTypePercentage = Number(dtConfig.standardPercentage);
        }
      }
    }

    // ── Pricing ──
    const expressMultiplier = Math.max(1, Number(input.expressMultiplier ?? 1));
    const count = await this.orderRepo.count();
    const orderNumber = `ORD${String(count.count + 1).padStart(6, '0')}`;

    const itemPricings: Array<{
      serviceId: string;
      itemId: string;
      quantity: number;
      basePrice: number;
      appliedPercentage: number | null;
      priceSource: string;
      resolvedPrice: number;
      unitPrice: number;
      totalPrice: number;
      estimatedDurationInDays: number | null;
      specialInstructions?: string;
      specialInstructionMediaIds?: string[];
      remarks?: string;
      additionalChargeIds?: string[];
      additionalServiceIds?: string[];
      additionalChargesTotal: number;
    }> = [];

    for (const item of input.items) {
      const pricing = await this.resolvePricing(input.storeId, item.serviceId, item.itemId);
      const unitPrice = parseFloat((pricing.resolvedPrice * expressMultiplier).toFixed(2));
      const totalPrice = parseFloat((unitPrice * item.quantity).toFixed(2));

      let additionalChargesTotal = 0;
      for (const chargeId of item.additionalChargeIds ?? []) {
        const charge = await this.additionalChargeRepo.findById(chargeId);
        additionalChargesTotal += Number(charge.defaultAmount);
      }

      itemPricings.push({
        ...item,
        basePrice: pricing.basePrice,
        appliedPercentage: pricing.appliedPercentage,
        priceSource: pricing.priceSource,
        resolvedPrice: pricing.resolvedPrice,
        unitPrice,
        totalPrice,
        estimatedDurationInDays: pricing.estimatedDurationInDays,
        additionalChargesTotal,
      });
    }

    // ── ETA calculation ──
    // Take the max estimated duration across all items, then compress by expressMultiplier
    const maxDays = itemPricings.reduce(
      (max, i) => Math.max(max, i.estimatedDurationInDays ?? 0),
      0,
    );
    const etaDays = maxDays > 0 ? Math.ceil(maxDays / expressMultiplier) : null;
    const deliveryDate = etaDays
      ? new Date(Date.now() + etaDays * 24 * 60 * 60 * 1000)
      : undefined;

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

    const gstConfig = await this.gstConfigRepo.findOne({where: {isActive: true, isDeleted: false}});
    const taxableAmount = subtotal - discountAmount;
    const gstRate = gstConfig ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage) : 0;
    const taxAmount = gstRate > 0 ? parseFloat(((taxableAmount * gstRate) / 100).toFixed(2)) : 0;
    const totalAmount = taxableAmount + taxAmount;

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
      const orderInitialStatus = input.isDraft
        ? OrderStatus.DRAFT
        : isStoreDropoffOrder
        ? OrderStatus.RECEIVED_AT_STORE
        : OrderStatus.CONFIRMED;

      const order = await this.orderRepo.create(
        {
          orderNumber,
          customerId: input.customerId,
          storeId: input.storeId,
          orderType: input.orderType,
          status: orderInitialStatus,
          expressMultiplier,
          deliveryType: input.deliveryType,
          deliveryTypePercentage,
          customerContactId: input.customerContactId,
          deliveryDate,
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
            basePrice: item.basePrice,
            appliedPercentage: item.appliedPercentage ?? undefined,
            priceSource: item.priceSource,
            resolvedPrice: item.resolvedPrice,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            specialInstructions: item.specialInstructions,
            specialInstructionMediaIds: item.specialInstructionMediaIds,
            remarks: item.remarks,
            additionalServiceIds: item.additionalServiceIds,
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

      // Auto-create garments for store drop-off with full inspection data
      const createdGarments: object[] = [];
      if (isStoreDropoffOrder) {
        const now = new Date();
        // Fetch count once — inside a transaction uncommitted rows aren't visible,
        // so querying per-garment returns the same value every time → duplicate tags.
        const baseGarmentCount = await this.garmentRepo.count();
        let garmentSeq = baseGarmentCount.count;

        for (let itemIdx = 0; itemIdx < createdItems.length; itemIdx++) {
          const orderItem = createdItems[itemIdx];
          const inputItem = input.items[itemIdx];

          for (let unitIdx = 0; unitIdx < orderItem.quantity; unitIdx++) {
            const unitInspection = inputItem.units?.[unitIdx];
            garmentSeq++;
            const garmentTagNumber = `GT${String(garmentSeq).padStart(8, '0')}`;

            const garment = await this.garmentRepo.create(
              {
                orderItemId: orderItem.id,
                garmentTagNumber,
                status: GarmentStatus.RECEIVED,
                brandId: unitInspection?.brandId,
                colorId: unitInspection?.colorId,
                qrPrintCount: unitInspection?.qrPrintCount ?? 1,
                customerRemarks: unitInspection?.instructions,
              },
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

            if (unitInspection) {
              await this.saveGarmentInspection(garment.id, unitInspection, tx, v4);
            }

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

    // Fetch once so the sequence stays consistent across multiple creates
    const baseCount = await this.garmentRepo.count();
    let garmentSeq = baseCount.count;

    for (const item of orderItems) {
      // Check how many garments already exist (idempotent — skip if already created)
      const existing = await this.garmentRepo.count({orderItemId: item.id, isDeleted: false});
      const toCreate = item.quantity - existing.count;
      if (toCreate <= 0) continue;

      for (let i = 0; i < toCreate; i++) {
        garmentSeq++;
        const garmentTagNumber = `GT${String(garmentSeq).padStart(8, '0')}`;

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

  // ─── List Orders (enriched) ───────────────────────────────────────────────

  async listOrders(params: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    orderType?: string;
    status?: string;
    limit?: number;
    skip?: number;
  }): Promise<{rows: object[]; total: number}> {
    const limit = Math.min(Number(params.limit ?? 20), 100);
    const skip = Number(params.skip ?? 0);

    const baseConditions: object[] = [{isDeleted: false}];

    if (params.status) baseConditions.push({status: params.status});
    if (params.orderType) baseConditions.push({orderType: params.orderType});
    if (params.dateFrom || params.dateTo) {
      const range: Record<string, string> = {};
      if (params.dateFrom) range.gte = params.dateFrom;
      if (params.dateTo) range.lte = params.dateTo;
      baseConditions.push({createdAt: range});
    }

    if (params.search) {
      const q = params.search.trim();
      const orConditions: object[] = [{orderNumber: {ilike: `%${q}%`}}];

      // Match by customer name
      const nameCustomers = await this.customerRepo.find({
        where: {and: [{isDeleted: false}, {or: [{firstName: {ilike: `%${q}%`}}, {lastName: {ilike: `%${q}%`}}]}]} as any,
        fields: {id: true} as any,
      });
      const nameCustomerIds = nameCustomers.map(c => c.id);

      // Match by phone via users table
      const phoneUsers = await this.userRepo.find({
        where: {and: [{isDeleted: false}, {phone: {ilike: `%${q}%`}}]} as any,
        fields: {id: true} as any,
      });
      let phoneCustomerIds: string[] = [];
      if (phoneUsers.length) {
        const userIds = phoneUsers.map(u => u.id);
        const phoneCustomers = await this.customerRepo.find({
          where: {and: [{isDeleted: false}, {userId: {inq: userIds}}]} as any,
          fields: {id: true} as any,
        });
        phoneCustomerIds = phoneCustomers.map(c => c.id);
      }

      const allCustomerIds = [...new Set([...nameCustomerIds, ...phoneCustomerIds])];
      if (allCustomerIds.length) orConditions.push({customerId: {inq: allCustomerIds}});

      baseConditions.push({or: orConditions});
    }

    const where = baseConditions.length === 1 ? baseConditions[0] : {and: baseConditions};

    const [orders, countResult] = await Promise.all([
      this.orderRepo.find({where: where as any, order: ['createdAt DESC'], limit, skip}),
      this.orderRepo.count(where as any),
    ]);

    if (!orders.length) return {rows: [], total: 0};

    const orderIds = orders.map(o => o.id);
    const customerIds = [...new Set(orders.map(o => o.customerId))];

    const [customers, paymentTxns] = await Promise.all([
      this.customerRepo.find({where: {id: {inq: customerIds}} as any}),
      this.paymentTransactionRepo.find({where: {orderId: {inq: orderIds}} as any}),
    ]);

    const userIds = [...new Set(customers.map(c => c.userId).filter(Boolean))];
    const users = userIds.length
      ? await this.userRepo.find({
          where: {id: {inq: userIds}} as any,
          fields: {id: true, phone: true, countryCode: true} as any,
        })
      : [];

    const customerMap = new Map(customers.map(c => [c.id, c]));
    const userMap = new Map(users.map(u => [u.id, u]));

    const paymentsByOrder = new Map<string, number>();
    for (const pt of paymentTxns) {
      paymentsByOrder.set(pt.orderId, (paymentsByOrder.get(pt.orderId) ?? 0) + Number(pt.amount));
    }

    const rows = orders.map(order => {
      const customer = customerMap.get(order.customerId);
      const user = customer ? userMap.get(customer.userId) : undefined;
      const totalCollected = paymentsByOrder.get(order.id) ?? 0;
      const totalAmount = Number(order.totalAmount ?? 0);
      const balanceDue = Math.max(0, totalAmount - totalCollected);

      let paymentStatus: string;
      if (totalAmount === 0) paymentStatus = 'pending';
      else if (totalCollected >= totalAmount) paymentStatus = 'paid';
      else if (totalCollected > 0) paymentStatus = 'partial';
      else paymentStatus = 'pending';

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        status: order.status,
        deliveryType: order.deliveryType,
        createdAt: order.createdAt,
        deliveryDate: order.deliveryDate,
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        taxAmount: order.taxAmount,
        totalAmount: order.totalAmount,
        totalCollected,
        balanceDue,
        paymentStatus,
        customer: customer
          ? {
              id: customer.id,
              firstName: customer.firstName,
              lastName: customer.lastName,
              fullName: `${customer.firstName} ${customer.lastName}`,
              email: customer.email,
              sensitivityScore: customer.sensitivityScore ?? null,
              phone: user?.phone ?? null,
              countryCode: user?.countryCode ?? null,
            }
          : null,
      };
    });

    return {rows, total: countResult.count};
  }

  // ─── Get Order Details ────────────────────────────────────────────────────

  async getOrderDetails(orderId: string): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    // ── Parallel batch 1: order sub-tables ───────────────────────────────────
    const [orderItems, orderCharges, statusHistory, paymentTransactions] = await Promise.all([
      this.orderItemRepo.find({where: {orderId}}),
      this.orderChargeRepo.find({where: {orderId}}),
      this.statusHistoryRepo.find({where: {orderId}, order: ['changedAt ASC']}),
      this.paymentTransactionRepo.find({where: {orderId}}),
    ]);

    const orderItemIds = orderItems.map(i => i.id);
    const serviceIds = [...new Set(orderItems.map(i => i.serviceId))];
    const itemIds = [...new Set(orderItems.map(i => i.itemId))];

    // ── Parallel batch 2: customer, services, items, garments, item charges ──
    const [customer, services, items, garments, itemCharges] = await Promise.all([
      this.customerRepo.findOne({where: {id: order.customerId, isDeleted: false}}),
      serviceIds.length ? this.serviceRepo.find({where: {id: {inq: serviceIds}} as any}) : Promise.resolve([]),
      itemIds.length ? this.itemRepo.find({where: {id: {inq: itemIds}} as any}) : Promise.resolve([]),
      orderItemIds.length ? this.garmentRepo.find({where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as any}) : Promise.resolve([]),
      orderItemIds.length ? this.orderItemChargeRepo.find({where: {orderItemId: {inq: orderItemIds}} as any}) : Promise.resolve([]),
    ]);

    // ── Customer phone ────────────────────────────────────────────────────────
    let customerUser = null;
    if (customer?.userId) {
      customerUser = await this.userRepo.findOne({
        where: {id: customer.userId} as any,
        fields: {id: true, phone: true, countryCode: true} as any,
      });
    }

    // ── Garment stage histories ───────────────────────────────────────────────
    const garmentIds = garments.map(g => g.id);
    const garmentHistories = garmentIds.length
      ? await this.garmentStatusHistoryRepo.find({
          where: {garmentId: {inq: garmentIds}} as any,
          order: ['changedAt ASC'],
        })
      : [];

    // ── Build lookup maps ─────────────────────────────────────────────────────
    const serviceMap = new Map(services.map(s => [s.id, s]));
    const itemMap = new Map(items.map(i => [i.id, i]));
    const garmentsByItem = new Map<string, typeof garments[0][]>();
    for (const g of garments) {
      const list = garmentsByItem.get(g.orderItemId) ?? [];
      list.push(g);
      garmentsByItem.set(g.orderItemId, list);
    }
    const historiesByGarment = new Map<string, typeof garmentHistories[0][]>();
    for (const h of garmentHistories) {
      const list = historiesByGarment.get(h.garmentId) ?? [];
      list.push(h);
      historiesByGarment.set(h.garmentId, list);
    }
    const chargesByItem = new Map<string, typeof itemCharges[0][]>();
    for (const c of itemCharges) {
      const list = chargesByItem.get(c.orderItemId) ?? [];
      list.push(c);
      chargesByItem.set(c.orderItemId, list);
    }

    // ── Stage status helper ───────────────────────────────────────────────────
    const STAGES: {key: string; status: GarmentStatus}[] = [
      {key: 'receive', status: GarmentStatus.RECEIVED},
      {key: 'inspect', status: GarmentStatus.IN_INSPECTION},
      {key: 'process', status: GarmentStatus.IN_PROCESS},
      {key: 'dispatch', status: GarmentStatus.OUT_FOR_DELIVERY},
      {key: 'deliver', status: GarmentStatus.DELIVERED},
    ];

    const resolveStages = (garmentId: string) => {
      const history = historiesByGarment.get(garmentId) ?? [];
      const result: Record<string, {done: boolean; at: Date | null}> = {};
      for (const stage of STAGES) {
        const entry = history.find(h => h.status === stage.status);
        result[stage.key] = {done: !!entry, at: entry?.changedAt ?? null};
      }
      return result;
    };

    // ── Assemble enriched items ───────────────────────────────────────────────
    const enrichedItems = orderItems.map(oi => ({
      id: oi.id,
      serviceId: oi.serviceId,
      serviceName: serviceMap.get(oi.serviceId)?.name ?? null,
      itemId: oi.itemId,
      itemName: itemMap.get(oi.itemId)?.name ?? null,
      quantity: oi.quantity,
      basePrice: oi.basePrice,
      resolvedPrice: oi.resolvedPrice,
      unitPrice: oi.unitPrice,
      totalPrice: oi.totalPrice,
      priceSource: oi.priceSource,
      additionalServiceIds: oi.additionalServiceIds ?? [],
      additionalCharges: chargesByItem.get(oi.id) ?? [],
      garments: (garmentsByItem.get(oi.id) ?? []).map(g => ({
        id: g.id,
        garmentTagNumber: g.garmentTagNumber,
        status: g.status,
        brandId: g.brandId,
        colorId: g.colorId,
        customerRemarks: g.customerRemarks,
        inspectionRemarks: g.inspectionRemarks,
        stages: resolveStages(g.id),
      })),
    }));

    // ── Payment summary ───────────────────────────────────────────────────────
    const totalCollected = paymentTransactions.reduce((s, p) => s + Number(p.amount), 0);
    const totalAmount = Number(order.totalAmount ?? 0);
    const balanceDue = Math.max(0, totalAmount - totalCollected);

    return {
      order: {
        ...order,
        customer: customer
          ? {
              id: customer.id,
              firstName: customer.firstName,
              lastName: customer.lastName,
              fullName: `${customer.firstName} ${customer.lastName}`,
              email: customer.email,
              sensitivityScore: customer.sensitivityScore ?? null,
              phone: customerUser?.phone ?? null,
              countryCode: customerUser?.countryCode ?? null,
            }
          : null,
      },
      items: enrichedItems,
      orderCharges,
      statusHistory,
      paymentTransactions,
      totalCollected,
      balanceDue,
    };
  }

  // ─── Split Order ─────────────────────────────────────────────────────────

  async splitOrder(
    orderId: string,
    garmentIds: string[],
    remarks: string | undefined,
    createdBy: string,
  ): Promise<object> {
    const {v4} = await import('uuid');

    if (!garmentIds?.length) {
      throw new HttpErrors.BadRequest('Provide at least one garment to split.');
    }

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.DELIVERED) {
      throw new HttpErrors.BadRequest(`Cannot split a ${order.status} order.`);
    }

    const garments = await this.garmentRepo.find({
      where: {id: {inq: garmentIds}, isDeleted: false} as any,
    });
    if (garments.length !== garmentIds.length) {
      throw new HttpErrors.BadRequest('One or more garments not found.');
    }
    const notReady = garments.filter(g => g.status !== GarmentStatus.READY);
    if (notReady.length) {
      throw new HttpErrors.BadRequest(
        `Garments must be in 'ready' status to split. Not ready: ${notReady.map(g => g.garmentTagNumber).join(', ')}`,
      );
    }

    // Validate garments belong to this order
    const orderItemIds = [...new Set(garments.map(g => g.orderItemId))];
    const parentOrderItems = await this.orderItemRepo.find({
      where: {id: {inq: orderItemIds}, orderId} as any,
    });
    if (parentOrderItems.length !== orderItemIds.length) {
      throw new HttpErrors.BadRequest('One or more garments do not belong to this order.');
    }

    // Group garments by orderItemId
    const garmentsByItem = new Map<string, typeof garments>();
    for (const g of garments) {
      const list = garmentsByItem.get(g.orderItemId) ?? [];
      list.push(g);
      garmentsByItem.set(g.orderItemId, list);
    }
    const parentItemMap = new Map(parentOrderItems.map(oi => [oi.id, oi]));

    // Calculate sub-order financials
    let subOrderSubtotal = 0;
    for (const [itemId, itemGarments] of garmentsByItem) {
      subOrderSubtotal += Number(parentItemMap.get(itemId)!.unitPrice ?? 0) * itemGarments.length;
    }
    const originalSubtotal = Number(order.subtotal ?? 0) || 1;
    const ratio = subOrderSubtotal / originalSubtotal;
    const subOrderDiscount = parseFloat((Number(order.discountAmount ?? 0) * ratio).toFixed(2));
    const subOrderTax = parseFloat((Number(order.taxAmount ?? 0) * ratio).toFixed(2));
    const subOrderTotal = parseFloat((subOrderSubtotal - subOrderDiscount + subOrderTax).toFixed(2));

    // Proportional payment allocation
    const existingPayments = await this.paymentTransactionRepo.find({where: {orderId}});
    const totalPaid = existingPayments.reduce((s, p) => s + Number(p.amount), 0);
    const allocatedPayment = parseFloat((totalPaid * ratio).toFixed(2));

    // Sub-order number: ORD000001-S1, ORD000001-S2, ...
    const subOrderCount = await this.orderRepo.count({parentOrderId: orderId} as any);
    const subOrderNumber = `${order.orderNumber}-S${subOrderCount.count + 1}`;

    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED' as any});
    try {
      const now = new Date();

      const subOrder = await this.orderRepo.create(
        {
          orderNumber: subOrderNumber,
          customerId: order.customerId,
          storeId: order.storeId,
          orderType: order.orderType,
          status: OrderStatus.OUT_FOR_DELIVERY,
          expressMultiplier: order.expressMultiplier,
          deliveryType: order.deliveryType,
          deliveryTypePercentage: order.deliveryTypePercentage,
          customerContactId: order.customerContactId,
          parentOrderId: order.id,
          subtotal: subOrderSubtotal,
          discountAmount: subOrderDiscount,
          discountType: order.discountType,
          taxAmount: subOrderTax,
          totalAmount: subOrderTotal,
          allocatedPayment,
          remarks,
        },
        {transaction: tx},
      );

      const createdSubItems = [];
      for (const [itemId, itemGarments] of garmentsByItem) {
        const oi = parentItemMap.get(itemId)!;
        const qty = itemGarments.length;
        const subItemTotal = parseFloat((Number(oi.unitPrice ?? 0) * qty).toFixed(2));

        const subOrderItem = await this.orderItemRepo.create(
          {
            orderId: subOrder.id,
            serviceId: oi.serviceId,
            itemId: oi.itemId,
            quantity: qty,
            basePrice: oi.basePrice,
            priceSource: oi.priceSource,
            appliedPercentage: oi.appliedPercentage,
            resolvedPrice: oi.resolvedPrice,
            unitPrice: oi.unitPrice,
            totalPrice: subItemTotal,
            additionalServiceIds: oi.additionalServiceIds,
          },
          {transaction: tx},
        );
        createdSubItems.push(subOrderItem);

        for (const garment of itemGarments) {
          await this.garmentRepo.updateById(
            garment.id,
            {orderItemId: subOrderItem.id, status: GarmentStatus.OUT_FOR_DELIVERY},
            {transaction: tx},
          );
          await this.garmentStatusHistoryRepo.create(
            {
              id: v4(),
              garmentId: garment.id,
              status: GarmentStatus.OUT_FOR_DELIVERY,
              changedAt: now,
              changedBy: createdBy,
              remarks: `Split from order ${order.orderNumber}`,
            },
            {transaction: tx},
          );
        }
      }

      // Mark parent as partially dispatched
      await this.orderRepo.updateById(
        orderId,
        {status: OrderStatus.PARTIALLY_DISPATCHED},
        {transaction: tx},
      );
      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId,
          status: OrderStatus.PARTIALLY_DISPATCHED,
          changedAt: now,
          changedBy: createdBy,
          remarks: `Split order created: ${subOrderNumber}`,
        },
        {transaction: tx},
      );

      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId: subOrder.id,
          status: OrderStatus.OUT_FOR_DELIVERY,
          changedAt: now,
          changedBy: createdBy,
          remarks: `Split from order ${order.orderNumber}`,
        },
        {transaction: tx},
      );

      await tx.commit();

      return {
        message: `Split order ${subOrderNumber} created successfully.`,
        subOrder: {...subOrder, status: OrderStatus.OUT_FOR_DELIVERY},
        subOrderItems: createdSubItems,
        garmentsSplit: garments.length,
        allocatedPayment,
        balanceDue: Math.max(0, subOrderTotal - allocatedPayment),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ─── Add Payment to Existing Order ───────────────────────────────────────

  async addPayment(
    orderId: string,
    payment: OrderPaymentInput,
    walletAmount: number,
    _performedBy: string,
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
