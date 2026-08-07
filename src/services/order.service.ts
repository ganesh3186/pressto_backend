import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PresstoDataSource} from '../datasources';
import {Order} from '../models/order.model';
import {Challan, ChallanStatus} from '../models/challan.model';
import {PaymentMode} from '../models/payment-mode.enum';
import {ReferenceType} from '../models/reference-type.enum';
import {OrderStatus, ORDER_STATUS_TRANSITIONS} from '../models/order-status.enum';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {HandoverCollectorType} from '../models/order-handover.model';
import {OrderType} from '../models/order-type.enum';
import {WalletTransactionType} from '../models/wallet-transaction-type.enum';
import {
  deriveGarmentGroupStatus,
  GarmentStatus,
  isActiveGarmentStatus,
} from '../models/garment-status.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {
  AdditionalChargeMasterRepository,
  ApprovalRequestRepository,
  ChallanRepository,
  ClusterPriceListRepository,
  ClusterRepository,
  CustomerContactRepository,
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerRepository,
  CustomerSecurityDepositRepository,
  DeliveryTypeConfigurationRepository,
  ItemRepository,
  ServiceRepository,
  UsersRepository,
  GarmentAdditionalServiceRepository,
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
  OrderHandoverRepository,
  OrderItemRepository,
  OrderLabelAssignmentRepository,
  OrderLabelRepository,
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
  // Metres — required per unit when the item is priced by measurement
  // (Item.isMeasurement), e.g. curtains billed per square metre (length × width).
  length?: number;
  width?: number;
  additionalChargeIds?: string[];   // add-ons + requirements for this specific unit
  additionalServiceIds?: string[];  // Service-catalog add-ons for this specific unit (e.g. hand-wash) — overrides the item's line-level additionalServiceIds when present
  stainMarks?: UnitStainMarkInput[];
  damageMarks?: UnitDamageMarkInput[];
  itemPhotoMediaIds?: string[];     // already-uploaded Media record IDs
  instructions?: string;            // stored as customerRemarks on Garment
  qrPrintCount?: number;
  // Reject-at-intake from the POS inspection popup: this piece is declined at
  // the counter — recorded but not billed, not processed, no garment.
  rejectedAtIntake?: boolean;
  rejectionReason?: string;
  rejectionRemarks?: string;
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
  expressMultiplier?: number;  // 1 = standard, 2 = 2x faster/costlier; drives the computed deliveryDate
  /**
   * Promised delivery date, when the counter picked one. Overrides the ETA the
   * backend would otherwise derive from item TATs and expressMultiplier. Omit
   * to keep that computed date.
   */
  deliveryDate?: string;
  payments?: OrderPaymentInput[];
  walletAmount?: number;
  orderLabelIds?: string[];
}

// The final order/invoice/challan total is always a whole rupee (≥ .5 rounds up).
// Component amounts (subtotal, tax, unit prices) keep their decimals — only the
// finalized total the customer sees/pays is rounded.
function roundRupee(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * What is still owed, in whole rupees.
 *
 * Money is compared at rupee resolution everywhere — order totals are stored
 * rounded, and subtracting raw floats otherwise produces noise like
 * `2685.1099999999997`, which then rejects a perfectly good ₹2685.11 payment.
 * Rounding both sides before subtracting also means a legacy order carrying
 * paise can still settle to exactly zero.
 */
function rupeeBalance(totalAmount: unknown, collected: unknown): number {
  return Math.max(0, roundRupee(totalAmount) - roundRupee(collected));
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
    @repository(CustomerSecurityDepositRepository) private securityDepositRepo: CustomerSecurityDepositRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
    @repository(ClusterPriceListRepository) private clusterPriceListRepo: ClusterPriceListRepository,
    @repository(PriceListRepository) private priceListRepo: PriceListRepository,
    @repository(StorePriceOverrideRepository) private storePriceOverrideRepo: StorePriceOverrideRepository,
    @repository(ServiceItemMappingRepository) private serviceItemMappingRepo: ServiceItemMappingRepository,
    @repository(AdditionalChargeMasterRepository) private additionalChargeRepo: AdditionalChargeMasterRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(GarmentAdditionalServiceRepository) private garmentAdditionalServiceRepo: GarmentAdditionalServiceRepository,
    @repository(GarmentStatusHistoryRepository) private garmentStatusHistoryRepo: GarmentStatusHistoryRepository,
    @repository(GarmentStainRepository) private garmentStainRepo: GarmentStainRepository,
    @repository(GarmentStainImageRepository) private garmentStainImageRepo: GarmentStainImageRepository,
    @repository(GarmentDamageRepository) private garmentDamageRepo: GarmentDamageRepository,
    @repository(GarmentDamageImageRepository) private garmentDamageImageRepo: GarmentDamageImageRepository,
    @repository(GarmentImageRepository) private garmentImageRepo: GarmentImageRepository,
    @repository(GstTaxConfigurationRepository) private gstConfigRepo: GstTaxConfigurationRepository,
    @repository(DeliveryTypeConfigurationRepository) private deliveryTypeConfigRepo: DeliveryTypeConfigurationRepository,
    @repository(CustomerContactRepository) private customerContactRepo: CustomerContactRepository,
    @repository(CustomerFamilyGroupRepository) private familyGroupRepo: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository) private familyMemberRepo: CustomerFamilyGroupMemberRepository,
    @repository(OrderHandoverRepository) private orderHandoverRepo: OrderHandoverRepository,
    @repository(OrderLabelAssignmentRepository) private orderLabelAssignmentRepo: OrderLabelAssignmentRepository,
    @repository(OrderLabelRepository) private orderLabelRepo: OrderLabelRepository,
    @repository(UsersRepository) private userRepo: UsersRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
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

  /**
   * Persists the additional services resolved for one specific unit onto its
   * now-created garment. Reads OrderItem.pendingUnitAdditionalServices — the
   * bridge written at pricing time (createOrder) — indexed by the unit's
   * true position within the line (not just its index within this creation
   * batch, since garments for a line can be created across multiple calls).
   * Called from both garment-creation sites: the store-dropoff immediate
   * path (inside createOrder()'s transaction) and autoCreateGarments (no
   * transaction — called later, outside order creation).
   */
  private async createUnitAdditionalServices(
    garmentId: string,
    orderItem: {pendingUnitAdditionalServices?: Array<Array<{serviceId: string; amount: number}>>},
    unitIndex: number,
    v4: () => string,
    tx?: any,
  ): Promise<void> {
    const services = orderItem.pendingUnitAdditionalServices?.[unitIndex] ?? [];
    for (const {serviceId, amount} of services) {
      await this.garmentAdditionalServiceRepo.create(
        {id: v4(), garmentId, serviceId, amount},
        tx ? {transaction: tx} : undefined,
      );
    }
  }

  // ─── Pricing ──────────────────────────────────────────────────────────────
  // Public so other services (e.g. approval upgrades) reprice through the same
  // store→cluster→region→base waterfall instead of re-implementing it.

  async resolvePricing(
    storeId: string,
    serviceId: string,
    itemId: string,
    options: {additional?: boolean} = {},
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

    // Additional (add-on) services run the SAME store→cluster→region waterfall
    // AND read the same `percentage` column as a primary service — there's no
    // separate uplift for additional services. `additionalServicePercentage` is
    // a different knob reserved for Additional Charges (AdditionalChargeMaster),
    // resolved separately via resolveAdditionalChargePercentage() below. A null
    // at one level falls through to the next level.
    const readPct = (row: {percentage?: number} | null) => {
      const value = row?.percentage;
      return value != null ? Number(value) : null;
    };
    const uplift = (pct: number, source: 'store' | 'cluster' | 'region') => ({
      basePrice: base,
      // Percentage is an uplift on base (30 = +30%). 0 = no change. First match wins.
      resolvedPrice: parseFloat((base * (1 + pct / 100)).toFixed(2)),
      appliedPercentage: pct,
      priceSource: source as 'store' | 'cluster' | 'region' | 'base',
      estimatedDurationInDays,
    });

    // Priority 1: store override
    const override = await this.storePriceOverrideRepo.findOne({
      where: {storeId, isActive: true, isDeleted: false},
    });
    const storePct = readPct(override);
    if (storePct != null) return uplift(storePct, 'store');

    // Priority 2: cluster price list
    const store = await this.storeRepo.findById(storeId);
    if (store.clusterId) {
      const clusterPriceList = await this.clusterPriceListRepo.findOne({
        where: {clusterId: store.clusterId, isActive: true, isDeleted: false},
      });
      const clusterPct = readPct(clusterPriceList);
      if (clusterPct != null) return uplift(clusterPct, 'cluster');

      // Priority 3: region price list
      const cluster = await this.clusterRepo.findById(store.clusterId);
      if (cluster.regionId) {
        const priceList = await this.priceListRepo.findOne({
          where: {regionId: cluster.regionId, isActive: true, isDeleted: false},
        });
        const regionPct = readPct(priceList);
        if (regionPct != null) return uplift(regionPct, 'region');
      }
    }

    // Fallback: base price as-is
    return {basePrice: base, resolvedPrice: base, appliedPercentage: null, priceSource: 'base', estimatedDurationInDays};
  }

  // ─── Additional Charge Pricing ──────────────────────────────────────────────
  // Same store→cluster→region waterfall as resolvePricing(), but keyed off
  // additionalServicePercentage (not the primary `percentage` column) and applied
  // to AdditionalChargeMaster.defaultAmount — mirrors
  // AdditionalChargePricesController so what actually gets billed matches what
  // GET /additional-charge-prices showed the counter. Resolved once per order
  // (the percentage only depends on storeId, not on which charge it's applied to).

  private async resolveAdditionalChargePercentage(storeId: string): Promise<number | null> {
    const override = await this.storePriceOverrideRepo.findOne({
      where: {storeId, isActive: true, isDeleted: false},
    });
    if (override?.additionalServicePercentage != null) {
      return Number(override.additionalServicePercentage);
    }

    const store = await this.storeRepo.findById(storeId);
    if (!store.clusterId) return null;

    const clusterPriceList = await this.clusterPriceListRepo.findOne({
      where: {clusterId: store.clusterId, isActive: true, isDeleted: false},
    });
    if (clusterPriceList?.additionalServicePercentage != null) {
      return Number(clusterPriceList.additionalServicePercentage);
    }

    const cluster = await this.clusterRepo.findById(store.clusterId);
    if (!cluster.regionId) return null;

    const priceList = await this.priceListRepo.findOne({
      where: {regionId: cluster.regionId, isActive: true, isDeleted: false},
    });
    return priceList?.additionalServicePercentage != null
      ? Number(priceList.additionalServicePercentage)
      : null;
  }

  private applyAdditionalChargeUplift(defaultAmount: number, percentage: number | null): number {
    return percentage !== null
      ? parseFloat((defaultAmount * (1 + percentage / 100)).toFixed(2))
      : defaultAmount;
  }

  /**
   * A service with `hasOwnProcess: false` (e.g. Presstoke, Repair, CC-Repair) has no
   * process steps of its own — the item does nothing unless at least one additional
   * service is attached. Catches that mistake at creation/edit time instead of the
   * confusing downstream `ProcessService.initProcess` failure at inspection.
   */
  private async assertItemsHaveRequiredAdditionalServices(
    items: {serviceId: string; additionalServiceIds?: string[]}[],
  ): Promise<void> {
    const serviceIds = [...new Set(items.map(i => i.serviceId))];
    const services = await this.serviceRepo.find({where: {id: {inq: serviceIds}} as any});
    const serviceById = new Map(services.map(s => [s.id, s]));

    for (const item of items) {
      const service = serviceById.get(item.serviceId);
      if (service?.hasOwnProcess === false && !item.additionalServiceIds?.length) {
        throw new HttpErrors.BadRequest(
          `"${service.name}" has no process of its own — select at least one additional service for this item.`,
        );
      }
    }
  }

  /**
   * Snapshots the order's current items into a Challan (the "Service Order"
   * receipt handed to the customer at intake) — same computation
   * `ChallanController.generate()` used to do inline; both now share this so
   * the numbers can't drift out of sync between the automatic and manual path.
   * Only one active (non-converted-to-invoice) challan exists per order — if
   * one is already there, it's returned as-is rather than duplicated.
   */
  async generateChallanForOrder(
    orderId: string,
    generatedBy: string,
    tx?: unknown,
  ): Promise<Challan> {
    // Called mid-transaction from createOrder() before the order/items are
    // committed — every read here MUST go through the same connection (`tx`)
    // or it sees nothing yet and this throws a false "Order not found."
    const txOpt = tx ? {transaction: tx} : undefined;

    const existing = await this.challanRepo.findOne({
      where: {orderId, status: {nin: [ChallanStatus.CONVERTED_TO_INVOICE]}} as any,
      ...txOpt,
    } as any);
    if (existing) return existing;

    const order = await this.orderRepo.findOne(
      {where: {id: orderId, isDeleted: false}},
      txOpt,
    );
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const orderItems = await this.orderItemRepo.find({where: {orderId}}, txOpt);
    const items = orderItems.map(oi => ({
      orderItemId: oi.id,
      serviceId: oi.serviceId,
      itemId: oi.itemId,
      quantity: Number(oi.quantity) || 0,
      unitPrice: Number(oi.unitPrice) || 0,
      totalPrice: Number(oi.totalPrice) || 0,
      additionalServiceIds: oi.additionalServiceIds ?? [],
      rejectedAtIntake: oi.rejectedAtIntake ?? false,
      rejectionReason: oi.rejectionReason ?? null,
    }));

    const subtotal = items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0);
    const gstRate = 0.09; // 9% CGST + 9% SGST
    const cgst = parseFloat((subtotal * gstRate).toFixed(2));
    const sgst = parseFloat((subtotal * gstRate).toFixed(2));
    const discount = Number(order.discountAmount) || 0;
    const totalAmount = Math.round(subtotal - discount + cgst + sgst);

    const totalCount = await this.challanRepo.count();
    const challanNumber = `CHL-${String(totalCount.count + 1).padStart(6, '0')}`;

    const {v4} = await import('uuid');
    return this.challanRepo.create(
      {
        id: v4(),
        orderId,
        challanNumber,
        generatedBy,
        items,
        subtotal: parseFloat(subtotal.toFixed(2)),
        discount,
        deliveryCharge: 0,
        cgst,
        sgst,
        totalAmount,
        status: ChallanStatus.ISSUED,
      } as Partial<Challan>,
      txOpt,
    );
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

  // ─── On-Account Credit Status ───────────────────────────────────────────
  // The customer's security deposit doubles as their on-account credit limit
  // (no separate creditLimit field) — "used" is computed live as the sum of
  // totalAmount across every order that isn't yet fully paid off, rather than
  // stored, so it can never drift out of sync with real payment/order state.

  async computeOnAccountCreditStatus(
    customerId: string,
  ): Promise<{limit: number; used: number; remaining: number}> {
    const deposit = await this.securityDepositRepo.findOne({
      where: {customerId, isDeleted: false} as any,
    });
    const limit = roundRupee(deposit?.availableBalance ?? 0);

    const orders = await this.orderRepo.find({
      where: {
        customerId,
        isDeleted: false,
        status: {nin: [OrderStatus.DRAFT, OrderStatus.CANCELLED, OrderStatus.RETURNED]},
      } as any,
    });
    if (!orders.length) return {limit, used: 0, remaining: limit};

    const payments = await this.paymentTransactionRepo.find({
      where: {orderId: {inq: orders.map(o => o.id)}} as any,
    });
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      const amt = (p as any).transactionType === 'refund' ? 0 : Number((p as any).amount ?? 0);
      const oid = (p as any).orderId;
      paidByOrder.set(oid, (paidByOrder.get(oid) ?? 0) + amt);
    }

    // Full order total counts while any balance remains — released only once
    // the order is fully paid off, not proportionally as payments come in.
    let used = 0;
    for (const order of orders) {
      const paid = paidByOrder.get(order.id) ?? 0;
      const amountDue = rupeeBalance(order.totalAmount, paid);
      if (amountDue > 0) used += roundRupee(order.totalAmount);
    }

    const remaining = Math.max(0, limit - used);
    return {limit, used, remaining};
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

    await this.assertItemsHaveRequiredAdditionalServices(input.items);

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
    // Delivery tier is an uplift on the resolved price (standard 0% = no change,
    // express/lightning add their configured %). This is the single price knob.
    const deliveryMultiplier = 1 + (Number(deliveryTypePercentage) || 0) / 100;

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
      rejectedAtIntake?: boolean;
      rejectionReason?: string;
      rejectionRemarks?: string;
      units?: UnitInspectionInput[];
      pendingUnitAdditionalServices?: Array<Array<{serviceId: string; amount: number}>>;
    }> = [];

    // Reject-at-intake splits a line: units the counter declined become a
    // separate ₹0 line here, so the rest of the pipeline (pricing, garment
    // creation) treats accepted and rejected pieces uniformly and index
    // alignment with itemPricings/createdItems is preserved.
    const workingItems: Array<
      CreateOrderItemInput & {
        rejectedAtIntake?: boolean;
        rejectionReason?: string;
        rejectionRemarks?: string;
      }
    > = [];
    for (const item of input.items) {
      const units = item.units ?? [];
      const rejectedUnits = units.filter(u => u?.rejectedAtIntake);
      if (!rejectedUnits.length) {
        workingItems.push(item);
        continue;
      }

      const acceptedUnits = units.filter(u => !u?.rejectedAtIntake);
      // Quantity may exceed the inspected units; the surplus counts as accepted.
      const impliedAccepted = Math.max(0, item.quantity - units.length);
      const acceptedCount = acceptedUnits.length + impliedAccepted;

      if (acceptedCount > 0) {
        workingItems.push({...item, quantity: acceptedCount, units: acceptedUnits});
      }

      workingItems.push({
        ...item,
        quantity: rejectedUnits.length,
        units: rejectedUnits,
        // A declined line carries no charges or add-ons.
        additionalChargeIds: [],
        additionalServiceIds: [],
        rejectedAtIntake: true,
        rejectionReason: rejectedUnits[0]?.rejectionReason,
        rejectionRemarks:
          rejectedUnits.map(u => u?.rejectionRemarks).filter(Boolean).join('; ') || undefined,
      });
    }

    // Resolved once for the whole order — depends only on storeId, reused for
    // every item-level and order-level additional charge below.
    const additionalChargePercentage = await this.resolveAdditionalChargePercentage(input.storeId);

    for (const item of workingItems) {
      const pricing = await this.resolvePricing(input.storeId, item.serviceId, item.itemId);

      // A rejected line is recorded but never billed — everything payable is 0,
      // so it falls out of every subtotal while still appearing on documents.
      const rejected = Boolean(item.rejectedAtIntake);

      const units = item.units ?? [];

      // Per-unit additional-service selection: a unit's own selection wins;
      // falls back to the line-level list so single-quantity lines (and any
      // caller not yet sending per-unit data) price exactly as before —
      // only a genuinely non-uniform selection changes the total.
      const unitServiceIdLists: string[][] = rejected
        ? []
        : Array.from({length: item.quantity}, (_, i) => units[i]?.additionalServiceIds ?? item.additionalServiceIds ?? []);

      // Resolve each distinct additional-service id used anywhere on this
      // line once — same resolvePricing() cost as before when selection is
      // uniform, avoids redundant lookups when it isn't.
      const distinctServiceIds = [...new Set(unitServiceIdLists.flat())];
      const resolvedServicePrices = new Map<string, {resolvedPrice: number; estimatedDurationInDays: number}>();
      for (const addlServiceId of distinctServiceIds) {
        const addlPricing = await this.resolvePricing(input.storeId, addlServiceId, item.itemId, {
          additional: true,
        });
        resolvedServicePrices.set(addlServiceId, {
          resolvedPrice: addlPricing.resolvedPrice,
          estimatedDurationInDays: addlPricing.estimatedDurationInDays ?? 0,
        });
      }
      // TAT stays line-level and conservative (sum of every distinct extra
      // service used anywhere on the line) — unchanged from before, not
      // something that needs to become per-unit.
      const additionalServicesDays = distinctServiceIds.reduce(
        (sum, id) => sum + (resolvedServicePrices.get(id)?.estimatedDurationInDays ?? 0),
        0,
      );

      // Base per-piece price (garment + service, delivery-multiplied, no
      // additional services) — kept as a display reference. totalPrice below
      // is the authoritative amount once per-unit selection isn't uniform.
      const unitPrice = rejected
        ? 0
        : parseFloat((pricing.resolvedPrice * deliveryMultiplier).toFixed(2));

      // Measurement items (e.g. curtains) are billed per square metre: each
      // unit's contribution is its own price × its own area (length ×
      // width). Every accepted unit must carry both a length and a width.
      const catalogItem = rejected ? null : await this.itemRepo.findById(item.itemId);
      const isMeasurement = Boolean(catalogItem?.isMeasurement);

      const unitAreas: number[] = [];
      if (!rejected && isMeasurement) {
        if (units.length < item.quantity) {
          throw new HttpErrors.BadRequest(
            `Length and width are required for every unit of a measurement item (itemId: ${item.itemId}).`,
          );
        }
        for (const unit of units) {
          const length = Number(unit?.length);
          const width = Number(unit?.width);
          if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) {
            throw new HttpErrors.BadRequest(
              `Each unit of a measurement item (itemId: ${item.itemId}) needs a length and width greater than 0.`,
            );
          }
          unitAreas.push(length * width);
        }
      }

      // Sum each unit's own (base + its own additional services) — equals
      // unitPrice × quantity (or × areaTotal) exactly when selection is
      // uniform across the line, same as the previous single-multiply formula.
      const perUnitTotalPrices = unitServiceIdLists.map((ids, i) => {
        const addlAmount = ids.reduce((sum, id) => sum + (resolvedServicePrices.get(id)?.resolvedPrice ?? 0), 0);
        const perUnitPrice = parseFloat(((pricing.resolvedPrice + addlAmount) * deliveryMultiplier).toFixed(2));
        return isMeasurement ? perUnitPrice * (unitAreas[i] ?? 0) : perUnitPrice;
      });
      const totalPrice = rejected
        ? 0
        : parseFloat(perUnitTotalPrices.reduce((sum, p) => sum + p, 0).toFixed(2));

      // A declined piece needs no turnaround — it is not being processed.
      const estimatedDurationInDays = rejected
        ? null
        : (pricing.estimatedDurationInDays ?? 0) + additionalServicesDays || null;

      let additionalChargesTotal = 0;
      if (!rejected) {
        for (const chargeId of item.additionalChargeIds ?? []) {
          const charge = await this.additionalChargeRepo.findById(chargeId);
          additionalChargesTotal += this.applyAdditionalChargeUplift(
            Number(charge.defaultAmount),
            additionalChargePercentage,
          );
        }
      }

      // Bridges to garment-creation time (see OrderItem.pendingUnitAdditionalServices) —
      // one entry per unit, each the resolved {serviceId, amount} pairs for that unit.
      const pendingUnitAdditionalServices = unitServiceIdLists.map(ids =>
        ids.map(id => ({serviceId: id, amount: resolvedServicePrices.get(id)?.resolvedPrice ?? 0})),
      );

      itemPricings.push({
        ...item,
        basePrice: rejected ? 0 : pricing.basePrice,
        appliedPercentage: pricing.appliedPercentage,
        priceSource: pricing.priceSource,
        resolvedPrice: rejected ? 0 : pricing.resolvedPrice,
        unitPrice,
        totalPrice,
        estimatedDurationInDays,
        additionalChargesTotal,
        pendingUnitAdditionalServices,
      });
    }

    // ── ETA calculation ──
    // Take the max estimated duration across all items, then compress by expressMultiplier
    const maxDays = itemPricings.reduce(
      (max, i) => Math.max(max, i.estimatedDurationInDays ?? 0),
      0,
    );
    const etaDays = maxDays > 0 ? Math.ceil(maxDays / expressMultiplier) : null;
    const computedDeliveryDate = etaDays
      ? new Date(Date.now() + etaDays * 24 * 60 * 60 * 1000)
      : undefined;

    // The counter may promise a specific date — a customer collecting on their
    // way back, or a slot the store can actually staff. An explicit date wins;
    // without one the computed ETA stands, which is what every existing caller
    // relies on.
    let deliveryDate = computedDeliveryDate;
    if (input.deliveryDate) {
      const requested = new Date(input.deliveryDate);
      if (isNaN(requested.getTime())) {
        throw new HttpErrors.BadRequest('deliveryDate is not a valid date.');
      }
      deliveryDate = requested;
    }

    const orderChargeDetails: Array<{id: string; amount: number}> = [];
    let orderChargesTotal = 0;
    for (const chargeId of input.additionalChargeIds ?? []) {
      const charge = await this.additionalChargeRepo.findById(chargeId);
      const amount = this.applyAdditionalChargeUplift(
        Number(charge.defaultAmount),
        additionalChargePercentage,
      );
      orderChargesTotal += amount;
      orderChargeDetails.push({id: chargeId, amount});
    }

    const itemsSubtotal = parseFloat(
      itemPricings.reduce((s, i) => s + i.totalPrice + i.additionalChargesTotal, 0).toFixed(2),
    );
    const subtotal = parseFloat((itemsSubtotal + orderChargesTotal).toFixed(2));

    const {discountAmount, discountType} = this.applyCustomerDiscount(
      subtotal,
      customer.defaultDiscountType,
      customer.defaultDiscountValue ? Number(customer.defaultDiscountValue) : 0,
    );

    const gstConfig = await this.gstConfigRepo.findOne({where: {isActive: true, isDeleted: false}});
    const taxableAmount = parseFloat((subtotal - discountAmount).toFixed(2));
    const gstRate = gstConfig ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage) : 0;
    const taxAmount = gstRate > 0 ? parseFloat(((taxableAmount * gstRate) / 100).toFixed(2)) : 0;
    const totalAmount = roundRupee(taxableAmount + taxAmount);

    // "On Account" is a deferred-billing mode — nothing is actually collected
    // at order creation; the balance stays outstanding until this customer's
    // delivered orders are later consolidated into one invoice (on-account
    // billing). Counting it as real cash-in-hand here would silently mark
    // the order fully paid despite the customer never having paid anything,
    // so it's excluded before anything sums payments into totalCollected.
    const collectablePayments = (input.payments ?? []).filter(
      p => p.paymentMode !== PaymentMode.ON_ACCOUNT,
    );

    // Validate that payment amounts don't exceed total
    const paymentsTotal = collectablePayments.reduce((s, p) => s + Number(p.amount), 0);
    const totalCollected = paymentsTotal + walletAmount;
    if (totalCollected > totalAmount) {
      throw new HttpErrors.BadRequest(
        `Total collected (₹${totalCollected}) exceeds order total (₹${totalAmount}).`,
      );
    }

    // ── On-account credit-limit gate ──
    // The security deposit doubles as the credit limit for on-account
    // customers — checked before the transaction opens, same posture as the
    // wallet-balance check above.
    const isOnAccountCustomer =
      customer.customerEntityType === 'business' || customer.isOnAccountEligible === true;
    if (isOnAccountCustomer) {
      const creditStatus = await this.computeOnAccountCreditStatus(input.customerId);
      if (totalAmount > creditStatus.remaining) {
        throw new HttpErrors.BadRequest(
          `On-account credit limit exceeded. Available: ₹${creditStatus.remaining}, Order total: ₹${totalAmount}`,
        );
      }
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
            pendingUnitAdditionalServices: item.pendingUnitAdditionalServices,
            rejectedAtIntake: item.rejectedAtIntake ?? false,
            rejectionReason: item.rejectionReason,
            rejectionRemarks: item.rejectionRemarks,
          },
          {transaction: tx},
        );

        // Rejected lines carry no charges (they were stripped during the split).
        if (!item.rejectedAtIntake) {
          for (const chargeId of item.additionalChargeIds ?? []) {
            const charge = await this.additionalChargeRepo.findById(chargeId);
            const amount = this.applyAdditionalChargeUplift(
              Number(charge.defaultAmount),
              additionalChargePercentage,
            );
            await this.orderItemChargeRepo.create(
              {orderItemId: orderItem.id, additionalChargeId: chargeId, amount},
              {transaction: tx},
            );
          }
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
          const inputItem = workingItems[itemIdx];

          // A rejected piece is declined at the counter — no garment, no
          // processing. It stays a ₹0 record on the order.
          if (inputItem?.rejectedAtIntake) continue;

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
                length: unitInspection?.length,
                width: unitInspection?.width,
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
            await this.createUnitAdditionalServices(garment.id, orderItem, unitIdx, v4, tx);

            createdGarments.push(garment);
          }
        }
      }

      // Payment transactions (cash / card / UPI etc.) — on_account entries are
      // deliberately excluded (see collectablePayments above): nothing was
      // actually collected, so no transaction record is created for them.
      const createdPayments = [];
      for (const payment of collectablePayments) {
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
        const lockedWallet = await this.walletRepo.findById(wallet.id, undefined, {transaction: tx} as any);
        if (Number(lockedWallet.currentBalance) < walletAmount) {
          throw new HttpErrors.BadRequest(
            `Insufficient wallet balance at checkout. Available: ₹${lockedWallet.currentBalance}, Requested: ₹${walletAmount}`,
          );
        }

        const newBalance = Number(lockedWallet.currentBalance) - walletAmount;
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
        // Record wallet payment in payment_transaction so totalCollected queries stay consistent
        const walletPt = await this.paymentTransactionRepo.create(
          {
            orderId: order.id,
            paymentMode: PaymentMode.WALLET,
            amount: walletAmount,
            paymentDate: new Date(),
          },
          {transaction: tx},
        );
        createdPayments.push(walletPt);
      }

      for (const orderLabelId of input.orderLabelIds ?? []) {
        await this.orderLabelAssignmentRepo.create(
          {orderId: order.id, orderLabelId},
          {transaction: tx},
        );
      }

      // Every new order gets its "Service Order" receipt (Challan) right away,
      // in the same transaction, so it's available for the frontend to
      // download the moment order creation succeeds.
      const challan = await this.generateChallanForOrder(order.id, createdBy, tx);

      await tx.commit();

      return {
        order: {...order, status: orderInitialStatus},
        items: createdItems,
        garments: createdGarments,
        payments: createdPayments,
        challan,
        walletAmountDeducted: walletAmount,
        totalCollected,
        balanceDue: rupeeBalance(totalAmount, totalCollected),
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

  // ─── Rework Order (free reprocess) ──────────────────────────────────────────
  // A delivered item was not done properly, so it comes back through the factory
  // at no charge. That rework is a NEW order at ₹0, linked to the original —
  // never a reopening of the delivered one, whose garments are terminal and
  // whose record should stay a true account of the first pass.
  //
  // Called from the approval effect, once a store exec has approved the request.

  async createReworkOrder(params: {
    originalOrderId: string;
    garmentIds: string[];
    createdBy: string;
    reason?: string;
    remarks?: string;
  }): Promise<{order: Order; garmentsCreated: number}> {
    const {v4} = await import('uuid');

    const original = await this.orderRepo.findOne({
      where: {id: params.originalOrderId, isDeleted: false},
    });
    if (!original) throw new HttpErrors.NotFound('Original order not found.');

    const garments = await this.garmentRepo.find({
      where: {id: {inq: params.garmentIds}, isDeleted: false} as any,
    });
    if (!garments.length) {
      throw new HttpErrors.BadRequest('None of the requested garments exist.');
    }

    // Group the pieces by the order item they came from, so the rework order
    // carries one line per item with the right quantity.
    const originalItems = await this.orderItemRepo.find({
      where: {orderId: params.originalOrderId},
    });
    const itemById = new Map(originalItems.map(oi => [oi.id, oi]));

    const countByItem = new Map<string, number>();
    for (const garment of garments) {
      const orderItem = itemById.get(garment.orderItemId);
      if (!orderItem) continue; // garment from a different order — ignore
      countByItem.set(orderItem.id, (countByItem.get(orderItem.id) ?? 0) + 1);
    }
    if (!countByItem.size) {
      throw new HttpErrors.BadRequest('The selected garments do not belong to this order.');
    }

    const count = await this.orderRepo.count();
    const orderNumber = `ORD${String(count.count + 1).padStart(6, '0')}`;
    const now = new Date();

    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED' as any});
    let reworkOrder: Order;
    try {
      // Every money field is zero by design — the customer already paid for this
      // work once. Starts at received_at_store because the pieces are physically
      // back with us.
      reworkOrder = await this.orderRepo.create(
        {
          orderNumber,
          customerId: original.customerId,
          storeId: original.storeId,
          orderType: original.orderType,
          status: OrderStatus.RECEIVED_AT_STORE,
          reprocessOfOrderId: original.id,
          expressMultiplier: 1,
          deliveryType: original.deliveryType,
          deliveryTypePercentage: 0,
          subtotal: 0,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: 0,
          allocatedPayment: 0,
          remarks: [`Rework of ${original.orderNumber}`, params.reason, params.remarks]
            .filter(Boolean)
            .join(' — '),
        },
        {transaction: tx},
      );

      for (const [orderItemId, quantity] of countByItem) {
        const source = itemById.get(orderItemId)!;
        await this.orderItemRepo.create(
          {
            orderId: reworkOrder.id,
            serviceId: source.serviceId,
            itemId: source.itemId,
            quantity,
            // Priced at zero throughout — this is the free redo.
            basePrice: 0,
            resolvedPrice: 0,
            unitPrice: 0,
            totalPrice: 0,
            priceSource: source.priceSource,
            additionalServiceIds: source.additionalServiceIds,
            remarks: `Rework of order item ${source.id}`,
          },
          {transaction: tx},
        );
      }

      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId: reworkOrder.id,
          status: OrderStatus.RECEIVED_AT_STORE,
          changedAt: now,
          changedBy: params.createdBy,
          remarks: `Free rework raised against ${original.orderNumber}`,
        },
        {transaction: tx},
      );

      // Recorded on the original too, so its history shows the complaint.
      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId: original.id,
          status: original.status!,
          changedAt: now,
          changedBy: params.createdBy,
          remarks: `Rework order ${orderNumber} raised for ${garments.length} item(s)`,
        },
        {transaction: tx},
      );

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    // Fresh garments with new tags — the originals stay delivered. Outside the
    // transaction because autoCreateGarments manages its own tag sequence.
    const created = await this.autoCreateGarments(reworkOrder.id, params.createdBy, v4);

    return {order: reworkOrder, garmentsCreated: created.length};
  }

  // ─── Edit Order Items ───────────────────────────────────────────────────────
  // The counter changing what is on an order after it was booked — a customer
  // ringing up to add a shirt, or handing over one fewer than counted.
  //
  // Allowed up to in_inspection: past that the pieces are on the factory floor.
  // Takes the full desired item list and diffs it, so it mirrors the POS cart.
  // Garments are reconciled to match, and the order total is recalculated from
  // scratch using the same rules as order creation. Money is not touched — the
  // difference simply becomes balance due, collected through the normal flow.

  private static readonly ITEM_EDITABLE_STATUSES = new Set<OrderStatus>([
    OrderStatus.DRAFT,
    OrderStatus.CONFIRMED,
    OrderStatus.RECEIVED_AT_STORE,
    OrderStatus.IN_INSPECTION,
  ]);

  async updateOrderItems(
    orderId: string,
    desiredItems: {
      serviceId: string;
      itemId: string;
      quantity: number;
      additionalServiceIds?: string[];
      additionalChargeIds?: string[];
      specialInstructions?: string;
      specialInstructionMediaIds?: string[];
      remarks?: string;
    }[],
    changedBy: string,
  ): Promise<object> {
    const {v4} = await import('uuid');

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    if (!OrderService.ITEM_EDITABLE_STATUSES.has(order.status as OrderStatus)) {
      throw new HttpErrors.BadRequest(
        `Items cannot be changed once the order is '${order.status}'. ` +
          'They are editable up to inspection only.',
      );
    }

    if (!desiredItems?.length) {
      throw new HttpErrors.BadRequest('An order must have at least one item.');
    }
    if (desiredItems.some(i => !i.serviceId || !i.itemId || Number(i.quantity) < 1)) {
      throw new HttpErrors.BadRequest('Every item needs a service, an item and a quantity of at least 1.');
    }

    await this.assertItemsHaveRequiredAdditionalServices(desiredItems);

    // A line is identified by service + item, matching how POS keys its cart.
    const lineKey = (serviceId: string, itemId: string) => `${serviceId}::${itemId}`;
    const desiredByKey = new Map(desiredItems.map(i => [lineKey(i.serviceId, i.itemId), i]));
    if (desiredByKey.size !== desiredItems.length) {
      throw new HttpErrors.BadRequest('The same service and item appears twice — merge them into one line.');
    }

    const existingItems = await this.orderItemRepo.find({where: {orderId}});
    const existingByKey = new Map(existingItems.map(oi => [lineKey(oi.serviceId, oi.itemId), oi]));

    // Removals are only safe while every garment on the line is still untouched.
    const removableGarments = await this.collectRemovableGarments(
      existingItems,
      desiredByKey,
      lineKey,
    );

    const deliveryMultiplier = 1 + (Number(order.deliveryTypePercentage) || 0) / 100;
    // Resolved once for the whole edit — depends only on storeId, reused for
    // every item-level additional charge below.
    const additionalChargePercentage = await this.resolveAdditionalChargePercentage(order.storeId!);
    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED' as any});

    try {
      // ── Lines that stay or arrive ──────────────────────────────────────────
      for (const [key, desired] of desiredByKey) {
        const pricing = await this.resolvePricing(order.storeId!, desired.serviceId, desired.itemId);

        let additionalServicesUnitPrice = 0;
        for (const addlServiceId of desired.additionalServiceIds ?? []) {
          const addl = await this.resolvePricing(order.storeId!, addlServiceId, desired.itemId, {
            additional: true,
          });
          additionalServicesUnitPrice += addl.resolvedPrice;
        }

        const unitPrice = parseFloat(
          ((pricing.resolvedPrice + additionalServicesUnitPrice) * deliveryMultiplier).toFixed(2),
        );
        const totalPrice = parseFloat((unitPrice * desired.quantity).toFixed(2));

        // Note: estimatedDurationInDays is deliberately not stored — OrderItem
        // has no such column. Creation only uses it in memory to derive the
        // order's delivery date, which an edit leaves alone (see below).
        const fields = {
          quantity: desired.quantity,
          basePrice: pricing.basePrice,
          appliedPercentage: pricing.appliedPercentage ?? undefined,
          priceSource: pricing.priceSource,
          resolvedPrice: pricing.resolvedPrice,
          unitPrice,
          totalPrice,
          specialInstructions: desired.specialInstructions,
          specialInstructionMediaIds: desired.specialInstructionMediaIds,
          remarks: desired.remarks,
          additionalServiceIds: desired.additionalServiceIds,
        };

        const existing = existingByKey.get(key);
        const orderItemId = existing
          ? (await this.orderItemRepo.updateById(existing.id, fields, {transaction: tx}), existing.id)
          : (
              await this.orderItemRepo.create(
                {orderId, serviceId: desired.serviceId, itemId: desired.itemId, ...fields},
                {transaction: tx},
              )
            ).id;

        // Item-level charges are replaced wholesale — simpler than diffing, and
        // they are always sent together with the line.
        await this.orderItemChargeRepo.deleteAll({orderItemId} as any, {transaction: tx});
        for (const chargeId of desired.additionalChargeIds ?? []) {
          const charge = await this.additionalChargeRepo.findById(chargeId);
          const amount = this.applyAdditionalChargeUplift(
            Number(charge.defaultAmount),
            additionalChargePercentage,
          );
          await this.orderItemChargeRepo.create(
            {orderItemId, additionalChargeId: chargeId, amount},
            {transaction: tx},
          );
        }
      }

      // ── Lines that leave ───────────────────────────────────────────────────
      for (const existing of existingItems) {
        if (desiredByKey.has(lineKey(existing.serviceId, existing.itemId))) continue;
        await this.orderItemChargeRepo.deleteAll({orderItemId: existing.id} as any, {transaction: tx});
        await this.orderItemRepo.deleteById(existing.id, {transaction: tx});
      }

      // ── Garments that leave ────────────────────────────────────────────────
      const now = new Date();
      for (const garment of removableGarments) {
        await this.garmentRepo.updateById(
          garment.id,
          {isDeleted: true, deletedAt: now as unknown as Date},
          {transaction: tx},
        );
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    // Garments for added items and increased quantities. Runs outside the
    // transaction because autoCreateGarments manages its own sequence, and it
    // only applies once the order has physically arrived.
    let garmentsCreated = 0;
    if (order.status !== OrderStatus.DRAFT && order.status !== OrderStatus.CONFIRMED) {
      garmentsCreated = (await this.autoCreateGarments(orderId, changedBy, v4)).length;
    }

    const totals = await this.recalculateOrderTotals(orderId);

    await this.statusHistoryRepo.create({
      id: v4(),
      orderId,
      status: order.status!,
      changedAt: new Date(),
      changedBy,
      remarks: `Items edited at counter — total now ₹${totals.totalAmount}`,
    });

    return {
      message: 'Order items updated.',
      ...totals,
      garmentsCreated,
      garmentsRemoved: removableGarments.length,
    };
  }

  /**
   * Garments to drop for lines that shrank or disappeared — newest tag first, so
   * the pieces already handled keep their identity.
   *
   * Refuses rather than guesses: if a garment has moved past inspection, is on
   * hold or was returned, the line cannot shrink and the caller is told why.
   */
  private async collectRemovableGarments(
    existingItems: {id: string; serviceId: string; itemId: string; quantity: number}[],
    desiredByKey: Map<string, {quantity: number}>,
    lineKey: (serviceId: string, itemId: string) => string,
  ) {
    const shrinking = existingItems
      .map(oi => {
        const desired = desiredByKey.get(lineKey(oi.serviceId, oi.itemId));
        const targetQty = desired ? Number(desired.quantity) : 0;
        return {orderItem: oi, drop: oi.quantity - targetQty};
      })
      .filter(row => row.drop > 0);

    if (!shrinking.length) return [];

    const doomed: {id: string; garmentTagNumber?: string}[] = [];
    for (const {orderItem, drop} of shrinking) {
      const garments = await this.garmentRepo.find({
        where: {orderItemId: orderItem.id, isDeleted: false} as any,
        order: ['garmentTagNumber DESC'],
      });
      if (!garments.length) continue; // nothing tagged yet — order item alone is enough

      const blocked = garments.find(
        g =>
          g.status !== GarmentStatus.RECEIVED && g.status !== GarmentStatus.IN_INSPECTION,
      );
      if (blocked) {
        throw new HttpErrors.Conflict(
          `Cannot remove pieces: garment ${blocked.garmentTagNumber} is '${blocked.status}'. ` +
            'Only pieces still at the counter or inspection desk can be removed.',
        );
      }

      doomed.push(...garments.slice(0, drop));
    }

    return doomed;
  }

  /**
   * Rebuilds subtotal, discount, tax and total from whatever is currently on the
   * order, using the same rules as creation. Never lowers the total below what
   * has already been collected — refunds are a separate decision.
   */
  private async recalculateOrderTotals(orderId: string) {
    const order = await this.orderRepo.findById(orderId);
    const customer = await this.customerRepo.findById(order.customerId);

    const items = await this.orderItemRepo.find({where: {orderId}});
    const itemIds = items.map(i => i.id);
    const [itemCharges, orderCharges] = await Promise.all([
      itemIds.length
        ? this.orderItemChargeRepo.find({where: {orderItemId: {inq: itemIds}} as any})
        : Promise.resolve([]),
      this.orderChargeRepo.find({where: {orderId}}),
    ]);

    const itemsSubtotal = parseFloat(
      (
        items.reduce((s, i) => s + Number(i.totalPrice ?? 0), 0) +
        itemCharges.reduce((s, c) => s + Number(c.amount ?? 0), 0)
      ).toFixed(2),
    );
    const orderChargesTotal = orderCharges.reduce((s, c) => s + Number(c.amount ?? 0), 0);
    const subtotal = parseFloat((itemsSubtotal + orderChargesTotal).toFixed(2));

    const {discountAmount, discountType} = this.applyCustomerDiscount(
      subtotal,
      customer.defaultDiscountType,
      customer.defaultDiscountValue ? Number(customer.defaultDiscountValue) : 0,
    );

    const gstConfig = await this.gstConfigRepo.findOne({where: {isActive: true, isDeleted: false}});
    const taxableAmount = parseFloat((subtotal - discountAmount).toFixed(2));
    const gstRate = gstConfig
      ? Number(gstConfig.cgstPercentage) + Number(gstConfig.sgstPercentage)
      : 0;
    const taxAmount = gstRate > 0 ? parseFloat(((taxableAmount * gstRate) / 100).toFixed(2)) : 0;
    const totalAmount = roundRupee(taxableAmount + taxAmount);

    // Dropping the total below what the customer already paid would leave the
    // order owing them money, and the refund route is not decided yet.
    const payments = await this.paymentTransactionRepo.find({where: {orderId}});
    const paid = payments.reduce(
      (s, p) => s + ((p as any).transactionType === 'refund' ? 0 : Number(p.amount ?? 0)),
      0,
    );
    const collected = Number(order.allocatedPayment ?? 0) > 0 ? Number(order.allocatedPayment) : paid;
    if (roundRupee(totalAmount) < roundRupee(collected)) {
      throw new HttpErrors.Conflict(
        `New total ₹${roundRupee(totalAmount)} is below the ₹${roundRupee(collected)} already ` +
          'collected. Refund the difference first, then edit the items.',
      );
    }

    await this.orderRepo.updateById(orderId, {
      subtotal,
      discountAmount,
      discountType,
      taxAmount,
      totalAmount,
    });

    return {
      subtotal,
      discountAmount,
      taxAmount,
      totalAmount,
      totalCollected: collected,
      balanceDue: rupeeBalance(totalAmount, collected),
    };
  }

  // ─── Counter inspection completed ───────────────────────────────────────────
  // When the counter staff inspect every piece while booking the order, there is
  // nothing left for the inspection desk to do — the whole order moves straight
  // to processing. Walks each garment forward to in_process one legal hop at a
  // time (received → in_inspection → in_process), then walks the order itself,
  // so the state machine and both history tables stay honest.

  /** Order must be live and past draft before any counter inspection is recorded. */
  private async assertInspectableOrder(orderId: string) {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED) {
      throw new HttpErrors.BadRequest(`Order is already '${order.status}'.`);
    }
    if (order.status === OrderStatus.DRAFT) {
      throw new HttpErrors.BadRequest('Confirm the order before recording inspection.');
    }
    return order;
  }

  /**
   * Moves an order forward to `target` one legal hop at a time, so every
   * intermediate transition is validated and written to history. Never moves
   * backwards. `received_at_store` is the hop that auto-creates garments.
   */
  private async stepOrderForward(
    orderId: string,
    target: OrderStatus,
    changedBy: string,
    remarks: string,
  ): Promise<void> {
    const PATH = [
      OrderStatus.CONFIRMED,
      OrderStatus.RECEIVED_AT_STORE,
      OrderStatus.IN_INSPECTION,
      OrderStatus.IN_PROCESS,
    ];
    const current = (await this.orderRepo.findById(orderId)).status!;
    const targetIdx = PATH.indexOf(target);
    if (targetIdx < 0) return;

    // on_hold sits outside the path but may resume straight to in_process.
    if (current === OrderStatus.ON_HOLD && target === OrderStatus.IN_PROCESS) {
      await this.changeStatus(orderId, target, changedBy, remarks);
      return;
    }

    let idx = PATH.indexOf(current);
    if (idx < 0 || idx >= targetIdx) return; // unknown status, or already there
    while (idx < targetIdx) {
      idx++;
      await this.changeStatus(orderId, PATH[idx], changedBy, remarks);
    }
  }

  /** Garments of an order, grouped by item and ordered so unit N maps to garment N. */
  private async garmentsByOrderItem(orderId: string) {
    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const orderItemIds = orderItems.map(i => i.id);
    const garments = orderItemIds.length
      ? await this.garmentRepo.find({
          where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as any,
          order: ['garmentTagNumber ASC'],
        })
      : [];

    const byItem = new Map<string, typeof garments>();
    for (const g of garments) {
      const list = byItem.get(g.orderItemId) ?? [];
      list.push(g);
      byItem.set(g.orderItemId, list);
    }
    return {orderItems, garments, byItem};
  }

  /**
   * Walks one garment forward along received → in_inspection → in_process,
   * stopping at `target`. Returns true if it actually moved.
   */
  private async stepGarmentForward(
    garment: {id: string; status?: GarmentStatus},
    target: GarmentStatus,
    changedBy: string,
    remarks: string,
    v4: () => string,
  ): Promise<boolean> {
    const PATH = [GarmentStatus.RECEIVED, GarmentStatus.IN_INSPECTION, GarmentStatus.IN_PROCESS];
    // On-hold and returned garments are out of the pipeline — leave them be.
    if (!isActiveGarmentStatus(garment.status)) return false;

    let idx = PATH.indexOf(garment.status as GarmentStatus);
    const targetIdx = PATH.indexOf(target);
    if (idx < 0 || targetIdx < 0 || idx >= targetIdx) return false; // already there or past it

    const now = new Date();
    while (idx < targetIdx) {
      idx++;
      await this.garmentRepo.updateById(garment.id, {status: PATH[idx]});
      await this.garmentStatusHistoryRepo.create({
        id: v4(),
        garmentId: garment.id,
        status: PATH[idx],
        changedAt: now,
        changedBy,
        remarks,
      });
    }
    return true;
  }

  async completeCounterInspection(orderId: string, changedBy: string): Promise<object> {
    const {v4} = await import('uuid');
    await this.assertInspectableOrder(orderId);

    // Garments only exist from received_at_store onward, and changeStatus creates
    // them on that hop — so get the order there first.
    await this.stepOrderForward(
      orderId,
      OrderStatus.RECEIVED_AT_STORE,
      changedBy,
      'Received at counter',
    );

    const {garments} = await this.garmentsByOrderItem(orderId);
    if (!garments.length) {
      throw new HttpErrors.BadRequest('This order has no garments to inspect.');
    }

    let advanced = 0;
    for (const garment of garments) {
      const moved = await this.stepGarmentForward(
        garment as any,
        GarmentStatus.IN_PROCESS,
        changedBy,
        'Inspected at counter',
        v4,
      );
      if (moved) advanced++;
    }

    await this.stepOrderForward(
      orderId,
      OrderStatus.IN_PROCESS,
      changedBy,
      'All items inspected at counter',
    );

    const updated = await this.orderRepo.findById(orderId);
    return {
      message: 'Counter inspection completed. Order moved to processing.',
      orderStatus: updated.status,
      garmentsAdvanced: advanced,
      garmentsTotal: garments.length,
    };
  }

  // ─── Partial counter inspection ─────────────────────────────────────────────
  // Only some pieces were looked at while booking. Those garments move to
  // in_inspection; the rest stay received, so the order sits at the bottleneck
  // and the inspection desk still picks up what is left.

  async markUnitsInspected(
    orderId: string,
    units: {serviceId: string; itemId: string; unitIndex: number}[],
    changedBy: string,
  ): Promise<object> {
    const {v4} = await import('uuid');
    await this.assertInspectableOrder(orderId);

    if (!units?.length) {
      throw new HttpErrors.BadRequest('No inspected units supplied.');
    }

    await this.stepOrderForward(
      orderId,
      OrderStatus.RECEIVED_AT_STORE,
      changedBy,
      'Received at counter',
    );

    const {orderItems, garments, byItem} = await this.garmentsByOrderItem(orderId);
    if (!garments.length) {
      throw new HttpErrors.BadRequest('This order has no garments to inspect.');
    }

    // A cart line is one order item, keyed by service + item.
    const itemKey = (serviceId: string, itemId: string) => `${serviceId}::${itemId}`;
    const itemByKey = new Map(orderItems.map(oi => [itemKey(oi.serviceId, oi.itemId), oi]));

    let advanced = 0;
    for (const unit of units) {
      const orderItem = itemByKey.get(itemKey(unit.serviceId, unit.itemId));
      if (!orderItem) continue;
      const garment = (byItem.get(orderItem.id) ?? [])[unit.unitIndex];
      if (!garment) continue;

      const moved = await this.stepGarmentForward(
        garment as any,
        GarmentStatus.IN_INSPECTION,
        changedBy,
        'Inspected at counter',
        v4,
      );
      if (moved) advanced++;
    }

    // The order is only as far along as its least advanced garment.
    const current = await this.garmentRepo.find({
      where: {orderItemId: {inq: orderItems.map(i => i.id)}, isDeleted: false} as any,
      fields: {id: true, status: true} as any,
    });
    const bottleneck = deriveGarmentGroupStatus(current.map(g => g.status));
    if (bottleneck === GarmentStatus.IN_INSPECTION) {
      await this.stepOrderForward(
        orderId,
        OrderStatus.IN_INSPECTION,
        changedBy,
        'Inspection started at counter',
      );
    }

    const updated = await this.orderRepo.findById(orderId);
    return {
      message: 'Counter inspection recorded.',
      orderStatus: updated.status,
      garmentsAdvanced: advanced,
      garmentsTotal: garments.length,
    };
  }

  // ─── In-store Handover (counter pickup) ─────────────────────────────────────
  // Records who collected the order at the counter and marks it delivered. This
  // is the no-rider dispatch path. Steps:
  //   1. order must be in a handover-eligible status
  //   2. hard block if any balance is still due
  //   3. resolve the collector (self | saved contact | ad-hoc, optionally saved)
  //   4. write the order_handover record
  //   5. order → delivered, and cascade every active garment → delivered

  async handoverInStore(params: {
    orderId: string;
    collectorType: HandoverCollectorType;
    customerContactId?: string;
    familyGroupMemberId?: string;
    collectorName?: string;
    collectorPhone?: string;
    collectorRelationship?: ContactRelationship;
    saveAsContact?: boolean;
    remarks?: string;
    handedOverBy: string;
  }): Promise<object> {
    const {v4} = await import('uuid');
    const order = await this.orderRepo.findOne({where: {id: params.orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    // 1. Status must allow the move to delivered (same rule the transition map enforces).
    const allowed = ORDER_STATUS_TRANSITIONS[order.status!] ?? [];
    if (!allowed.includes(OrderStatus.DELIVERED)) {
      throw new HttpErrors.BadRequest(
        `Order in '${order.status}' cannot be handed over. It must be ready or out for delivery.`,
      );
    }

    const handoverCustomer = await this.customerRepo.findOne({
      where: {id: order.customerId, isDeleted: false},
    });

    // 2. Hard block on outstanding balance. Refund entries are money out — not
    // counted toward what the customer has paid. Waived for on-account
    // (business) customers — they're billed later via one consolidated
    // invoice covering several delivered orders, not per-order before handover.
    const payments = await this.paymentTransactionRepo.find({where: {orderId: params.orderId}});
    const paid = payments.reduce((s, p) => s + ((p as any).transactionType === 'refund' ? 0 : Number(p.amount ?? 0)), 0);
    const balanceDue = rupeeBalance(order.totalAmount, paid);
    const isOnAccountCustomer =
      handoverCustomer?.customerEntityType === 'business' || handoverCustomer?.isOnAccountEligible === true;
    if (balanceDue > 0 && !isOnAccountCustomer) {
      throw new HttpErrors.BadRequest(
        `Cannot hand over: ₹${balanceDue} is still due. Collect the balance first.`,
      );
    }

    // Reject a second active handover on the same order.
    const existing = await this.orderHandoverRepo.findOne({
      where: {orderId: params.orderId, isDeleted: false} as any,
    });
    if (existing) throw new HttpErrors.Conflict('This order has already been handed over.');

    // 3. Resolve the collector into a stored snapshot.
    let collectorName = (params.collectorName ?? '').trim();
    let collectorPhone = (params.collectorPhone ?? '').trim();
    let collectorRelationship = params.collectorRelationship;
    let customerContactId = params.customerContactId;
    let familyGroupMemberId = params.familyGroupMemberId;

    if (params.collectorType === HandoverCollectorType.SELF) {
      if (handoverCustomer) {
        collectorName =
          collectorName || `${handoverCustomer.firstName ?? ''} ${handoverCustomer.lastName ?? ''}`.trim();
      }
      customerContactId = undefined;
      familyGroupMemberId = undefined;
      collectorRelationship = undefined;
    } else if (params.collectorType === HandoverCollectorType.FAMILY_MEMBER) {
      if (!familyGroupMemberId) {
        throw new HttpErrors.BadRequest('Select the family member collecting the order.');
      }
      const member = await this.familyMemberRepo.findOne({
        where: {id: familyGroupMemberId, isDeleted: false} as any,
      });
      if (!member) throw new HttpErrors.NotFound('Selected family member not found.');
      // The member must belong to this order customer's own family group.
      const group = await this.familyGroupRepo.findOne({
        where: {id: member.groupId, isDeleted: false} as any,
      });
      if (!group || group.primaryCustomerId !== order.customerId) {
        throw new HttpErrors.BadRequest('That family member does not belong to this order’s customer.');
      }
      // Snapshot from the member so the record is stable if it changes later.
      collectorName = member.name;
      collectorPhone = member.phone ?? '';
      collectorRelationship = member.relationship;
      customerContactId = undefined;
    } else if (params.collectorType === HandoverCollectorType.CONTACT) {
      if (!customerContactId) {
        throw new HttpErrors.BadRequest('Select the household contact collecting the order.');
      }
      const contact = await this.customerContactRepo.findOne({
        where: {id: customerContactId, isDeleted: false} as any,
      });
      if (!contact) throw new HttpErrors.NotFound('Selected contact not found.');
      // Guard against picking a contact that belongs to a different customer.
      if (contact.customerId !== order.customerId) {
        throw new HttpErrors.BadRequest('That contact does not belong to this order’s customer.');
      }
      // Snapshot from the contact so the record is stable even if it is edited later.
      collectorName = contact.name;
      collectorPhone = contact.phone;
      collectorRelationship = contact.relationship;
      familyGroupMemberId = undefined;
    } else {
      // OTHER — ad-hoc collector.
      if (!collectorName) {
        throw new HttpErrors.BadRequest('Enter the name of the person collecting the order.');
      }
      customerContactId = undefined;
      familyGroupMemberId = undefined;

      // Optionally persist the ad-hoc person as a reusable contact for next time.
      if (params.saveAsContact) {
        const saved = await this.customerContactRepo.create({
          id: v4(),
          customerId: order.customerId,
          name: collectorName,
          phone: collectorPhone || 'N/A',
          relationship: collectorRelationship ?? ContactRelationship.OTHER,
        } as any);
        customerContactId = saved.id;
      }
    }

    // 4. Handover record.
    const handover = await this.orderHandoverRepo.create({
      id: v4(),
      orderId: params.orderId,
      collectorType: params.collectorType,
      customerContactId,
      familyGroupMemberId,
      collectorName,
      collectorPhone: collectorPhone || undefined,
      collectorRelationship,
      remarks: params.remarks?.trim() || undefined,
      handedOverBy: params.handedOverBy,
      handedOverAt: new Date(),
    });

    // 5a. Order → delivered (+ status history).
    await this.orderRepo.updateById(params.orderId, {status: OrderStatus.DELIVERED});
    await this.statusHistoryRepo.create({
      id: v4(),
      orderId: params.orderId,
      status: OrderStatus.DELIVERED,
      changedAt: new Date(),
      changedBy: params.handedOverBy,
      remarks: `In-store handover to ${collectorName}${params.remarks ? ` — ${params.remarks.trim()}` : ''}`,
    });

    // 5b. Cascade every still-active garment on the order to delivered.
    const cascaded = await this._cascadeGarmentsToDelivered(params.orderId, params.handedOverBy, v4);

    return {
      message: 'Order handed over.',
      handover,
      garmentsDelivered: cascaded,
    };
  }

  // Move every non-terminal garment on the order to delivered, with history.
  private async _cascadeGarmentsToDelivered(
    orderId: string,
    changedBy: string,
    v4: () => string,
  ): Promise<number> {
    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const orderItemIds = orderItems.map(i => i.id);
    if (!orderItemIds.length) return 0;

    const garments = await this.garmentRepo.find({
      where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as any,
    });

    // Already-delivered and returned garments are terminal — leave them.
    const toDeliver = garments.filter(
      g =>
        g.status !== GarmentStatus.DELIVERED &&
        g.status !== GarmentStatus.RETURNED_TO_CUSTOMER,
    );

    const now = new Date();
    for (const g of toDeliver) {
      await this.garmentRepo.updateById(g.id, {status: GarmentStatus.DELIVERED});
      await this.garmentStatusHistoryRepo.create({
        id: v4(),
        garmentId: g.id,
        status: GarmentStatus.DELIVERED,
        changedAt: now,
        changedBy,
        remarks: 'Delivered via in-store handover',
      });
    }
    return toDeliver.length;
  }

  // Fetch the handover record for an order, enriched with the linked contact.
  async getHandover(orderId: string): Promise<object | null> {
    const handover = await this.orderHandoverRepo.findOne({
      where: {orderId, isDeleted: false} as any,
      order: ['handedOverAt DESC'],
    });
    if (!handover) return null;

    let contact = null;
    if (handover.customerContactId) {
      contact = await this.customerContactRepo.findOne({
        where: {id: handover.customerContactId} as any,
      });
    }

    let familyMember = null;
    if (handover.familyGroupMemberId) {
      familyMember = await this.familyMemberRepo.findOne({
        where: {id: handover.familyGroupMemberId} as any,
      });
    }

    return {...handover, customerContact: contact, familyMember};
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

        // existing.count + i is this garment's true position among the
        // line's units — garments for one line can be created across
        // multiple calls (e.g. quantity increased later), so it isn't
        // always the same as the loop-local index i.
        await this.createUnitAdditionalServices(garment.id, item, existing.count + i, v4);

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
    customerId?: string;
    limit?: number;
    skip?: number;
    /**
     * Store ids the caller may see. Resolved from the caller's token by the
     * controller — never a client parameter. `null`/`undefined` means no store
     * filtering (global staff, and the customer-facing APIs, which scope by
     * customerId instead). An empty array matches nothing, which is the
     * intended fail-closed result for a store-bound user with no store.
     */
    storeIds?: string[] | null;
  }): Promise<{rows: object[]; total: number}> {
    const limit = Math.min(Number(params.limit ?? 20), 100);
    const skip = Number(params.skip ?? 0);

    const baseConditions: object[] = [{isDeleted: false}];

    if (Array.isArray(params.storeIds)) {
      baseConditions.push({storeId: {inq: params.storeIds}});
    }

    // Scopes the list to a single customer (used by the customer-facing APIs).
    if (params.customerId) baseConditions.push({customerId: params.customerId});
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
    const parentOrderIds = [...new Set(orders.map(o => (o as any).parentOrderId).filter(Boolean))];

    const [customers, paymentTxns, parentOrders, orderItems, labelAssignments] = await Promise.all([
      this.customerRepo.find({where: {id: {inq: customerIds}} as any}),
      this.paymentTransactionRepo.find({where: {orderId: {inq: orderIds}} as any}),
      parentOrderIds.length
        ? this.orderRepo.find({where: {id: {inq: parentOrderIds}} as any, fields: {id: true, orderNumber: true} as any})
        : Promise.resolve([]),
      this.orderItemRepo.find({
        where: {orderId: {inq: orderIds}} as any,
        fields: {orderId: true, quantity: true} as any,
      }),
      this.orderLabelAssignmentRepo.find({where: {orderId: {inq: orderIds}, isDeleted: false} as any}),
    ]);

    const labelIds = [...new Set(labelAssignments.map(a => a.orderLabelId))];
    const labels = labelIds.length
      ? await this.orderLabelRepo.find({where: {id: {inq: labelIds}} as any})
      : [];
    const labelById = new Map(labels.map(l => [l.id, l]));
    const labelsByOrder = new Map<string, {id: string; name: string; code: string}[]>();
    for (const a of labelAssignments) {
      const label = labelById.get(a.orderLabelId);
      if (!label) continue;
      const list = labelsByOrder.get(a.orderId) ?? [];
      list.push({id: label.id, name: label.name, code: label.code});
      labelsByOrder.set(a.orderId, list);
    }

    const userIds = [...new Set(customers.map(c => c.userId).filter(Boolean))];
    const users = userIds.length
      ? await this.userRepo.find({
          where: {id: {inq: userIds}} as any,
          fields: {id: true, phone: true, countryCode: true} as any,
        })
      : [];

    const customerMap = new Map(customers.map(c => [c.id, c]));
    const userMap = new Map(users.map(u => [u.id, u]));
    const parentOrderMap = new Map(parentOrders.map(o => [o.id, (o as any).orderNumber]));

    // Pieces in the order (3 shirts + 1 trouser = 4), not the number of item rows.
    const itemsCountByOrder = new Map<string, number>();
    for (const oi of orderItems) {
      const qty = Number(oi.quantity ?? 0) || 0;
      itemsCountByOrder.set(oi.orderId, (itemsCountByOrder.get(oi.orderId) ?? 0) + qty);
    }

    const paymentsByOrder = new Map<string, number>();
    const lastPaymentByOrder = new Map<string, {mode: string | null; paidAt: Date | null}>();
    for (const pt of paymentTxns) {
      // Refund entries are money out — excluded from amount collected.
      if ((pt as any).transactionType === 'refund') continue;
      paymentsByOrder.set(pt.orderId, (paymentsByOrder.get(pt.orderId) ?? 0) + Number(pt.amount));
      const prev = lastPaymentByOrder.get(pt.orderId);
      const paidAt = (pt as any).paidAt ?? (pt as any).createdAt ?? null;
      if (!prev || (paidAt && prev.paidAt && new Date(paidAt) > new Date(prev.paidAt)) || !prev.paidAt) {
        lastPaymentByOrder.set(pt.orderId, {mode: (pt as any).paymentMode ?? null, paidAt});
      }
    }

    const rows = orders.map(order => {
      const customer = customerMap.get(order.customerId);
      const user = customer ? userMap.get(customer.userId) : undefined;
      const txnCollected = paymentsByOrder.get(order.id) ?? 0;
      const allocPay = Number(order.allocatedPayment ?? 0);
      const isChildOrder = !!(order as any).parentOrderId;
      // Child orders: allocated base + any new payments recorded directly on the child
      // Split parent orders (allocPay > 0): use allocated share only (original txns are redistributed)
      // Regular orders: use transaction total
      const totalCollected = isChildOrder ? allocPay + txnCollected : allocPay > 0 ? allocPay : txnCollected;
      const totalAmount = Number(order.totalAmount ?? 0);
      const balanceDue = rupeeBalance(totalAmount, totalCollected);

      let paymentStatus: string;
      // A ₹0 order owes nothing — a free rework, or one fully covered by wallet
      // or advance. Reporting it as pending puts it in collections chasing zero.
      if (balanceDue === 0) paymentStatus = 'paid';
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
        orderItemsCount: itemsCountByOrder.get(order.id) ?? 0,
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        taxAmount: order.taxAmount,
        totalAmount: order.totalAmount,
        totalCollected,
        balanceDue,
        paymentStatus,
        lastPaymentMode: lastPaymentByOrder.get(order.id)?.mode ?? null,
        lastPaidAt: lastPaymentByOrder.get(order.id)?.paidAt ?? null,
        parentOrderId: (order as any).parentOrderId ?? null,
        parentOrderNumber: (order as any).parentOrderId ? (parentOrderMap.get((order as any).parentOrderId) ?? null) : null,
        // Marks a free rework so a ₹0 row in the list is explicable.
        reprocessOfOrderId: (order as any).reprocessOfOrderId ?? null,
        orderLabels: labelsByOrder.get(order.id) ?? [],
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
              customerEntityType: customer.customerEntityType,
              isOnAccountEligible: customer.isOnAccountEligible ?? false,
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
    const [orderItems, orderCharges, statusHistory, paymentTransactions, splitChildren, orderLabelAssignments] = await Promise.all([
      this.orderItemRepo.find({where: {orderId}}),
      this.orderChargeRepo.find({where: {orderId}}),
      this.statusHistoryRepo.find({where: {orderId}, order: ['changedAt ASC']}),
      this.paymentTransactionRepo.find({where: {orderId}}),
      this.orderRepo.find({where: {parentOrderId: orderId, isDeleted: false} as any, fields: {id: true, orderNumber: true, status: true, totalAmount: true, allocatedPayment: true} as any}),
      this.orderLabelAssignmentRepo.find({where: {orderId, isDeleted: false} as any}),
    ]);

    const orderLabels = orderLabelAssignments.length
      ? await this.orderLabelRepo.find({where: {id: {inq: orderLabelAssignments.map(a => a.orderLabelId)}} as any})
      : [];

    const orderItemIds = orderItems.map(i => i.id);
    const additionalSvcIds = orderItems.flatMap(i => (i.additionalServiceIds as string[] | null) ?? []);
    const serviceIds = [...new Set([...orderItems.map(i => i.serviceId), ...additionalSvcIds])];
    const itemIds = [...new Set(orderItems.map(i => i.itemId))];

    // ── Parallel batch 2: customer, services, items, garments, item charges ──
    const [customer, services, items, garments, itemCharges, parentOrder, reprocessOfOrder] =
      await Promise.all([
        this.customerRepo.findOne({where: {id: order.customerId, isDeleted: false}}),
      serviceIds.length ? this.serviceRepo.find({where: {id: {inq: serviceIds}} as any}) : Promise.resolve([]),
      itemIds.length ? this.itemRepo.find({where: {id: {inq: itemIds}} as any}) : Promise.resolve([]),
      orderItemIds.length ? this.garmentRepo.find({where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as any}) : Promise.resolve([]),
      orderItemIds.length ? this.orderItemChargeRepo.find({where: {orderItemId: {inq: orderItemIds}} as any}) : Promise.resolve([]),
      // This order is a split child — pull the parent so the UI can name and link
      // back to it, not just hold an opaque uuid.
      order.parentOrderId
        ? this.orderRepo.findOne({
            where: {id: order.parentOrderId} as any,
            fields: {id: true, orderNumber: true, status: true} as any,
          })
        : Promise.resolve(null),
      // This is a free rework — name the order it is redoing, so a ₹0 total
      // does not read as a billing error.
      order.reprocessOfOrderId
        ? this.orderRepo.findOne({
            where: {id: order.reprocessOfOrderId} as any,
            fields: {id: true, orderNumber: true, status: true} as any,
          })
        : Promise.resolve(null),
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
    const [garmentHistories, pendingApprovals] = await Promise.all([
      garmentIds.length
        ? this.garmentStatusHistoryRepo.find({
            where: {garmentId: {inq: garmentIds}} as any,
            order: ['changedAt ASC'],
          })
        : Promise.resolve([]),
      // A held garment (status on_hold) doesn't say WHY on its own — this is
      // what lets the order-status screen show "On Hold — Return Pending" vs
      // "On Hold — Damaged" instead of a bare, unexplained "On Hold".
      garmentIds.length
        ? this.approvalRequestRepo.find({
            where: {
              entityType: 'garment',
              entityId: {inq: garmentIds},
              status: ApprovalRequestStatus.PENDING,
            } as any,
          })
        : Promise.resolve([]),
    ]);
    const pendingApprovalByGarment = new Map(pendingApprovals.map(a => [a.entityId, a.type]));

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
      // order_item has no status column — an item is exactly as far along as its
      // least advanced garment, so it is derived rather than stored.
      status: deriveGarmentGroupStatus(
        (garmentsByItem.get(oi.id) ?? []).map(g => g.status),
      ),
      serviceId: oi.serviceId,
      serviceName: serviceMap.get(oi.serviceId)?.name ?? null,
      itemId: oi.itemId,
      itemName: itemMap.get(oi.itemId)?.name ?? null,
      // Drives the inspection popup's length/width fields (curtains etc,
      // billed by area) — the frontend reads this straight off each item.
      isMeasurement: itemMap.get(oi.itemId)?.isMeasurement ?? false,
      quantity: oi.quantity,
      // Declined at the counter — recorded, ₹0, no garments.
      rejectedAtIntake: oi.rejectedAtIntake ?? false,
      rejectionReason: oi.rejectionReason ?? null,
      rejectionRemarks: oi.rejectionRemarks ?? null,
      basePrice: oi.basePrice,
      resolvedPrice: oi.resolvedPrice,
      unitPrice: oi.unitPrice,
      totalPrice: oi.totalPrice,
      priceSource: oi.priceSource,
      additionalServiceIds: oi.additionalServiceIds ?? [],
      additionalServices: ((oi.additionalServiceIds as string[] | null) ?? []).map(id => ({
        id,
        name: serviceMap.get(id)?.name ?? null,
      })),
      additionalCharges: chargesByItem.get(oi.id) ?? [],
      garments: (garmentsByItem.get(oi.id) ?? []).map(g => ({
        id: g.id,
        orderItemId: g.orderItemId,
        garmentTagNumber: g.garmentTagNumber,
        status: g.status,
        // Only meaningful while status is on_hold — tells the UI which
        // approval flow (return / damage / reprocess / upgrade) is holding it.
        pendingApprovalType: pendingApprovalByGarment.get(g.id) ?? null,
        brandId: g.brandId,
        colorId: g.colorId,
        length: g.length,
        width: g.width,
        customerRemarks: g.customerRemarks,
        inspectionRemarks: g.inspectionRemarks,
        isTagPrinted: g.isTagPrinted ?? false,
        unprocessedHandlingMode: g.unprocessedHandlingMode ?? null,
        stages: resolveStages(g.id),
      })),
    }));

    // ── Payment summary ───────────────────────────────────────────────────────
    const txnCollected = paymentTransactions.reduce((s, p) => s + ((p as any).transactionType === 'refund' ? 0 : Number(p.amount)), 0);
    const allocPay = Number(order.allocatedPayment ?? 0);
    const isChildOrder = !!order.parentOrderId;
    // Child: allocated base (transferred from parent) + any new direct payments
    // Split parent (allocPay > 0): only the allocated share counts — original transactions were redistributed
    // Regular order: transaction total
    const totalCollected = isChildOrder ? allocPay + txnCollected : allocPay > 0 ? allocPay : txnCollected;
    const totalAmount = Number(order.totalAmount ?? 0);
    const balanceDue = rupeeBalance(totalAmount, totalCollected);

    return {
      order: {
        ...order,
        orderLabels: orderLabels.map(l => ({id: l.id, name: l.name, code: l.code})),
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
              customerEntityType: customer.customerEntityType,
              isOnAccountEligible: customer.isOnAccountEligible ?? false,
            }
          : null,
        // Mirrors splitChildren below: null on a regular order, populated when
        // this order was split off another. parentOrderId itself comes through
        // the spread above.
        parentOrderNumber: (parentOrder as any)?.orderNumber ?? null,
        // Free rework: the delivered order being redone. reprocessOfOrderId
        // itself comes through the spread above.
        reprocessOfOrderNumber: (reprocessOfOrder as any)?.orderNumber ?? null,
        parentOrder: parentOrder
          ? {
              id: parentOrder.id,
              orderNumber: (parentOrder as any).orderNumber,
              status: parentOrder.status,
            }
          : null,
        splitChildren: splitChildren.map(c => ({
          id: c.id,
          orderNumber: c.orderNumber,
          status: c.status,
          totalAmount: c.totalAmount,
          allocatedPayment: c.allocatedPayment,
        })),
      },
      items: enrichedItems,
      orderCharges,
      statusHistory,
      paymentTransactions,
      totalCollected,
      balanceDue,
      // Nothing outstanding = paid, including a ₹0 free rework order.
      paymentStatus: balanceDue === 0 ? 'paid' : totalCollected > 0 ? 'partial' : 'pending',
    };
  }

  // ─── Split Order ─────────────────────────────────────────────────────────

  async splitOrder(
    orderId: string,
    garmentIds: string[],
    deliveryDate: string | undefined,
    deliveryType: DeliveryType | undefined,
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
    // Reject only garments that are already dispatched or delivered
    const nonSplittable = garments.filter(g =>
      g.status === GarmentStatus.OUT_FOR_DELIVERY ||
      g.status === GarmentStatus.DELIVERED,
    );
    if (nonSplittable.length) {
      throw new HttpErrors.BadRequest(
        `Cannot split garments already dispatched or delivered: ${nonSplittable.map(g => g.garmentTagNumber).join(', ')}`,
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

    // Sub-order delivery tier: a NEW tier can be chosen at split time (e.g. split
    // an express garment out of a standard order). Otherwise inherit the parent's.
    const subDeliveryType = deliveryType ?? (order.deliveryType as DeliveryType | undefined);
    const deliveryChanged = deliveryType != null && deliveryType !== order.deliveryType;
    let subDeliveryPercentage = Number(order.deliveryTypePercentage) || 0;
    if (deliveryChanged) {
      const dtConfig = await this.deliveryTypeConfigRepo.findOne({where: {isDeleted: false}});
      if (dtConfig) {
        if (deliveryType === DeliveryType.EXPRESS) subDeliveryPercentage = Number(dtConfig.expressPercentage);
        else if (deliveryType === DeliveryType.LIGHTNING) subDeliveryPercentage = Number(dtConfig.lightningPercentage);
        else subDeliveryPercentage = Number(dtConfig.standardPercentage);
      }
    }
    const subDeliveryMultiplier = 1 + (Number(subDeliveryPercentage) || 0) / 100;

    // Per-piece price for the sub-order. When the tier changed, re-apply the new
    // delivery uplift on the delivery-independent resolvedPrice; else inherit the
    // parent unit price (already includes waterfall + parent delivery uplift).
    const subUnitPriceFor = (oi: {resolvedPrice?: number; basePrice?: number; unitPrice?: number}) =>
      deliveryChanged
        ? parseFloat((Number(oi.resolvedPrice ?? oi.basePrice ?? 0) * subDeliveryMultiplier).toFixed(2))
        : Number(oi.unitPrice ?? 0);

    // Discount/tax are split proportionally by the parent's original item share.
    let oldSubOrderSubtotal = 0;
    let subOrderSubtotal = 0;
    for (const [itemId, itemGarments] of garmentsByItem) {
      const oi = parentItemMap.get(itemId)!;
      oldSubOrderSubtotal += Number(oi.unitPrice ?? 0) * itemGarments.length;
      subOrderSubtotal += subUnitPriceFor(oi) * itemGarments.length;
    }
    subOrderSubtotal = parseFloat(subOrderSubtotal.toFixed(2));
    const originalSubtotal = Number(order.subtotal ?? 0) || 1;
    const ratio = oldSubOrderSubtotal / originalSubtotal;

    // Discount follows the parent's original item share (negotiated on the
    // original order, so it does not scale with an express uplift).
    const subOrderDiscount = parseFloat((Number(order.discountAmount ?? 0) * ratio).toFixed(2));

    // Effective GST rate the order was actually taxed at — derived from the
    // parent so it stays correct regardless of later config changes.
    const parentTaxable = Number(order.subtotal ?? 0) - Number(order.discountAmount ?? 0);
    const effectiveTaxRate = parentTaxable > 0 ? Number(order.taxAmount ?? 0) / parentTaxable : 0;

    // Child is taxed on its ACTUAL (possibly express-uplifted) taxable value, so
    // GST applies to the uplift too.
    const subOrderTax = parseFloat(((subOrderSubtotal - subOrderDiscount) * effectiveTaxRate).toFixed(2));
    const subOrderTotal = roundRupee(subOrderSubtotal - subOrderDiscount + subOrderTax);

    // The parent must lose only the ORIGINAL value of the moved garments, never
    // the child's re-tiered price. If the child was bumped to express, debiting
    // the parent by the higher price/tax cancels the uplift out and holds the
    // grand total flat — when it should rise by exactly the uplift + its GST.
    // The parent's tax loss is the OLD proportional share (matches its original
    // tax basis exactly); when the tier is unchanged, old == new and it's a no-op.
    const oldSubOrderTax = parseFloat((Number(order.taxAmount ?? 0) * ratio).toFixed(2));
    // When the tier is unchanged, oldSubOrderSubtotal/oldSubOrderTax are
    // algebraically IDENTICAL to subOrderSubtotal/subOrderTax (both derive
    // from the same per-garment unit prices) — but computing this value
    // independently and rounding it separately from subOrderTotal let the two
    // whole-rupee roundings land on different sides of .50, so
    // child.totalAmount + parent.totalAmount could drift a few rupees away
    // from the original order.totalAmount (a fully-paid order would then show
    // a phantom balance due after splitting). Reusing subOrderTotal directly
    // guarantees the two always sum back exactly. Only recompute independently
    // when the tier DID change, where the two totals are genuinely different
    // numbers by design.
    const oldSubOrderTotal = deliveryChanged
      ? roundRupee(oldSubOrderSubtotal - subOrderDiscount + oldSubOrderTax)
      : subOrderTotal;

    // Sub-order gets a normal sequential order number (same format as any other order)
    const totalOrderCount = await this.orderRepo.count();
    const subOrderNumber = `ORD${String(totalOrderCount.count + 1).padStart(6, '0')}`;

    // Derive sub-order status from the earliest garment status in the split set
    const GARMENT_STATUS_PRIORITY: GarmentStatus[] = [
      GarmentStatus.RECEIVED,
      GarmentStatus.IN_INSPECTION,
      GarmentStatus.IN_PROCESS,
      GarmentStatus.QUALITY_CHECK,
      GarmentStatus.READY,
    ];
    const GARMENT_TO_ORDER_STATUS: Partial<Record<GarmentStatus, OrderStatus>> = {
      [GarmentStatus.RECEIVED]: OrderStatus.RECEIVED_AT_STORE,
      [GarmentStatus.IN_INSPECTION]: OrderStatus.IN_INSPECTION,
      [GarmentStatus.IN_PROCESS]: OrderStatus.IN_PROCESS,
      [GarmentStatus.QUALITY_CHECK]: OrderStatus.QUALITY_CHECK,
      [GarmentStatus.READY]: OrderStatus.READY,
    };
    const earliestGarmentStatus = garments.reduce((min, g) => {
      const minIdx = GARMENT_STATUS_PRIORITY.indexOf(min);
      const gIdx = GARMENT_STATUS_PRIORITY.indexOf(g.status as GarmentStatus);
      return gIdx !== -1 && (minIdx === -1 || gIdx < minIdx) ? g.status as GarmentStatus : min;
    }, garments[0].status as GarmentStatus);
    const subOrderStatus = GARMENT_TO_ORDER_STATUS[earliestGarmentStatus] ?? OrderStatus.RECEIVED_AT_STORE;

    // Payment allocation: give existing payment to whichever order delivers first
    // (more advanced garment status = closer to delivery)
    const existingPayments = await this.paymentTransactionRepo.find({where: {orderId}});
    const txnPaid = existingPayments.reduce((s, p) => s + ((p as any).transactionType === 'refund' ? 0 : Number(p.amount)), 0);
    // Child orders carry no transaction records — their payment lives in allocatedPayment.
    // New direct payments (if any) are in txnPaid. Both must be included.
    const totalPaid = order.parentOrderId
      ? Number(order.allocatedPayment ?? 0) + txnPaid
      : txnPaid;

    // Find the earliest status among remaining (non-split) parent garments
    const allParentGarments = await this.garmentRepo.find({
      where: {orderItemId: {inq: parentOrderItems.map(oi => oi.id)}, isDeleted: false} as any,
    });
    const remainingGarments = allParentGarments.filter(g => !garmentIds.includes(g.id));
    const parentEarliestStatus = remainingGarments.length
      ? remainingGarments.reduce((min, g) => {
          const minIdx = GARMENT_STATUS_PRIORITY.indexOf(min);
          const gIdx = GARMENT_STATUS_PRIORITY.indexOf(g.status as GarmentStatus);
          return gIdx !== -1 && (minIdx === -1 || gIdx < minIdx) ? g.status as GarmentStatus : min;
        }, remainingGarments[0].status as GarmentStatus)
      : earliestGarmentStatus;

    const childStatusIdx = GARMENT_STATUS_PRIORITY.indexOf(earliestGarmentStatus);
    const parentStatusIdx = GARMENT_STATUS_PRIORITY.indexOf(parentEarliestStatus);

    // Higher index = more advanced pipeline stage = delivers sooner
    let allocatedPayment: number;
    let parentAllocatedPayment: number;
    const parentNewTotal = roundRupee(Number(order.totalAmount ?? 0) - oldSubOrderTotal);
    if (childStatusIdx >= parentStatusIdx) {
      // Child delivers first — give it full payment up to its total
      allocatedPayment = Math.min(totalPaid, subOrderTotal);
      parentAllocatedPayment = Math.max(0, totalPaid - allocatedPayment);
    } else {
      // Parent delivers first — keep payment on parent up to its (new) total
      parentAllocatedPayment = Math.min(totalPaid, parentNewTotal);
      allocatedPayment = Math.max(0, totalPaid - parentAllocatedPayment);
    }
    allocatedPayment = parseFloat(allocatedPayment.toFixed(2));
    parentAllocatedPayment = parseFloat(parentAllocatedPayment.toFixed(2));

    const tx = await this.dataSource.beginTransaction({isolationLevel: 'READ COMMITTED' as any});
    try {
      const now = new Date();

      const subOrder = await this.orderRepo.create(
        {
          orderNumber: subOrderNumber,
          customerId: order.customerId,
          storeId: order.storeId,
          orderType: order.orderType,
          status: subOrderStatus,
          expressMultiplier: Number(order.expressMultiplier ?? 1) || 1,
          deliveryType: subDeliveryType,
          deliveryTypePercentage: subDeliveryPercentage,
          customerContactId: order.customerContactId,
          parentOrderId: order.id,
          deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
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
        const newUnitPrice = subUnitPriceFor(oi);
        const subItemTotal = parseFloat((newUnitPrice * qty).toFixed(2));

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
            unitPrice: newUnitPrice,
            totalPrice: subItemTotal,
            additionalServiceIds: oi.additionalServiceIds,
          },
          {transaction: tx},
        );
        createdSubItems.push(subOrderItem);

        for (const garment of itemGarments) {
          // Re-parent to sub-order item; garment status stays as-is
          await this.garmentRepo.updateById(
            garment.id,
            {orderItemId: subOrderItem.id},
            {transaction: tx},
          );
        }
      }

      // Update parent order item quantities — reduce by the garments moved out
      for (const [itemId, itemGarments] of garmentsByItem) {
        const oi = parentItemMap.get(itemId)!;
        const newQty = Math.max(0, Number(oi.quantity) - itemGarments.length);
        if (newQty === 0) {
          await this.orderItemRepo.deleteById(oi.id, {transaction: tx} as any);
        } else {
          const newTotal = parseFloat((Number(oi.unitPrice ?? 0) * newQty).toFixed(2));
          await this.orderItemRepo.updateById(
            oi.id,
            {quantity: newQty, totalPrice: newTotal},
            {transaction: tx} as any,
          );
        }
      }

      // Reduce parent order financials. Subtotal drops by the ORIGINAL value of
      // the moved garments (oldSubOrderSubtotal), not the child's re-tiered price.
      const parentNewSubtotal = parseFloat((Number(order.subtotal ?? 0) - oldSubOrderSubtotal).toFixed(2));
      const parentNewDiscount = parseFloat((Number(order.discountAmount ?? 0) - subOrderDiscount).toFixed(2));
      const parentNewTax = parseFloat((Number(order.taxAmount ?? 0) - oldSubOrderTax).toFixed(2));
      await this.orderRepo.updateById(
        orderId,
        {
          subtotal: parentNewSubtotal,
          discountAmount: parentNewDiscount,
          taxAmount: parentNewTax,
          totalAmount: parentNewTotal,
          allocatedPayment: parentAllocatedPayment,
        },
        {transaction: tx} as any,
      );

      await this.statusHistoryRepo.create(
        {
          id: v4(),
          orderId,
          status: order.status,
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
          status: subOrderStatus,
          changedAt: now,
          changedBy: createdBy,
          remarks: `Split from order ${order.orderNumber}`,
        },
        {transaction: tx},
      );

      await tx.commit();

      return {
        message: `Split order ${subOrderNumber} created successfully.`,
        subOrder: {...subOrder, status: subOrderStatus},
        subOrderItems: createdSubItems,
        garmentsSplit: garments.length,
        allocatedPayment,
        balanceDue: rupeeBalance(subOrderTotal, allocatedPayment),
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
    const alreadyPaid = existing.reduce((s, p) => s + ((p as any).transactionType === 'refund' ? 0 : Number(p.amount)), 0);
    const due = rupeeBalance(order.totalAmount, alreadyPaid);

    // On Account is deferred billing — nothing is actually collected here;
    // see the matching guard in createOrder(). Force it to 0 so it can never
    // be counted as money in hand nor recorded as a payment transaction.
    const thisPayment =
      payment?.paymentMode === PaymentMode.ON_ACCOUNT ? 0 : Number(payment?.amount ?? 0);
    const thisWallet = Number(walletAmount ?? 0);
    const thisTotal = thisPayment + thisWallet;

    // Compared at rupee resolution, so ₹2685.11 against a ₹2685 balance passes
    // instead of tripping on a fraction of a paisa.
    if (roundRupee(thisTotal) > due) {
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

      let walletPayment = null;
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
        walletPayment = await this.paymentTransactionRepo.create(
          {
            orderId,
            paymentMode: PaymentMode.WALLET,
            amount: thisWallet,
            paymentDate: new Date(),
          },
          {transaction: tx},
        );
      }

      await tx.commit();

      const newPaid = alreadyPaid + thisTotal;
      return {
        message: 'Payment recorded.',
        payment: createdPayment,
        walletPayment,
        walletAmountDeducted: thisWallet,
        totalCollected: newPaid,
        balanceDue: rupeeBalance(order.totalAmount, newPaid),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}
