import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {Coupon} from '../models/coupon.model';
import {CouponDiscountType} from '../models/coupon-discount-type.enum';
import {Customer} from '../models/customer.model';
import {
  ClusterRepository,
  CouponCustomerRepository,
  CouponRedemptionRepository,
  CouponRepository,
  CustomerLabelAssignmentRepository,
  ItemRepository,
  ServiceRepository,
  StoreRepository,
} from '../repositories';

export interface CouponEvaluationItem {
  serviceId: string;
  itemId: string;
  quantity: number;
  totalPrice: number;
}

export interface CouponEvaluationInput {
  couponCode: string;
  customerId: string;
  storeId: string;
  items: CouponEvaluationItem[];
  // Set only by OrderService.createOrder's own referral auto-apply branch —
  // lets an isReferralCode coupon through evaluate() for that one internal
  // call, while every manual-entry path (POST /coupons/validate, and a
  // directly-typed input.couponCode at order creation) leaves this unset
  // and gets rejected above.
  allowReferralCoupon?: boolean;
}

export interface CouponEvaluationSuccess {
  valid: true;
  couponId: string;
  code: string;
  name: string;
  discountType: string;
  discountValue: number;
  eligibleSubtotal: number;
  discountAmount: number;
  qualifyingItemIndexes: number[];
}

export interface CouponEvaluationFailure {
  valid: false;
  reason: string;
}

export type CouponEvaluationResult = CouponEvaluationSuccess | CouponEvaluationFailure;

// Light DTO for the home-screen "active offers" list — no cart exists yet,
// so none of evaluate()'s item-scope/discount-amount fields apply.
export interface EligibleCouponDisplay {
  id: string;
  code: string;
  name: string;
  description?: string;
  colorTag?: string;
  discountType: string;
  discountValue: number;
  maxDiscountAmount?: number;
  minQualifyingItems?: number;
  endDate: string;
}

// Duplicated rather than imported from order.service.ts's roundRupee —
// OrderService.createOrder() calls into this service, so importing from
// there would create a circular module dependency.
function roundRupee(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function fail(reason: string): CouponEvaluationFailure {
  return {valid: false, reason};
}

/**
 * Single source of truth for "is this coupon usable, by this customer, at
 * this store, against these order lines, and for how much" — called by
 * both CouponController.validate() (HTTP, UI live-preview) and
 * OrderService.createOrder() (internal, at actual redemption time) so the
 * two paths can never evaluate a coupon differently.
 *
 * The date/usage-cap/geo/audience checks are also reused (via the private
 * helpers below) by listEligibleForDisplay(), which runs the same
 * customer/coupon-level rules with no cart — see that method.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class CouponService {
  constructor(
    @repository(CouponRepository) private couponRepo: CouponRepository,
    @repository(CouponCustomerRepository) private couponCustomerRepo: CouponCustomerRepository,
    @repository(CouponRedemptionRepository) private couponRedemptionRepo: CouponRedemptionRepository,
    @repository(CustomerLabelAssignmentRepository)
    private customerLabelAssignmentRepo: CustomerLabelAssignmentRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(ClusterRepository) private clusterRepo: ClusterRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
  ) {}

  async evaluate(input: CouponEvaluationInput): Promise<CouponEvaluationResult> {
    const normalizedCode = input.couponCode.trim().toUpperCase();
    const coupon = await this.couponRepo.findOne({
      where: {code: normalizedCode, isActive: true, isDeleted: false} as object,
    });
    if (!coupon) return fail('Coupon not found.');

    // A referral coupon is only ever attached via registration
    // (CustomerAuthController.register / CustomerController.create →
    // resolveReferralCoupon below) and auto-applied on the referred
    // customer's first order (OrderService.createOrder, passing
    // allowReferralCoupon: true) — never typed in manually at checkout,
    // by staff or the customer themselves.
    if (coupon.isReferralCode && !input.allowReferralCoupon) {
      return fail('This coupon can only be applied through referral registration, not entered manually.');
    }

    if (!this.isWithinValidityWindow(coupon)) return fail('This coupon is not currently valid.');

    const usageReason = await this.usageCapacityReason(coupon, input.customerId);
    if (usageReason) return fail(usageReason);

    const geoReason = await this.geoScopeReason(coupon, input.storeId);
    if (geoReason) return fail(geoReason);

    const audienceReason = await this.audienceScopeReason(coupon, input.customerId);
    if (audienceReason) return fail(audienceReason);

    // Service/item scope — filter order lines to the ones this coupon
    // actually applies to; discount is computed only against those.
    const hasServiceCategoryScope = (coupon.serviceCategoryIds?.length ?? 0) > 0;
    const hasServiceScope = (coupon.serviceIds?.length ?? 0) > 0;
    const hasItemCategoryScope = (coupon.itemCategoryIds?.length ?? 0) > 0;
    const hasItemScope = (coupon.itemIds?.length ?? 0) > 0;

    let qualifyingItemIndexes: number[];
    if (!hasServiceCategoryScope && !hasServiceScope && !hasItemCategoryScope && !hasItemScope) {
      qualifyingItemIndexes = input.items.map((_, idx) => idx);
    } else {
      const serviceIds = [...new Set(input.items.map(i => i.serviceId))];
      const itemIds = [...new Set(input.items.map(i => i.itemId))];
      const services = serviceIds.length
        ? await this.serviceRepo.find({where: {id: {inq: serviceIds}} as object})
        : [];
      const items = itemIds.length
        ? await this.itemRepo.find({where: {id: {inq: itemIds}} as object})
        : [];
      const serviceCategoryById = new Map(services.map(s => [s.id, s.serviceCategoryId]));
      const itemCategoryById = new Map(items.map(it => [it.id, it.itemCategoryId]));

      qualifyingItemIndexes = [];
      input.items.forEach((line, idx) => {
        const svcCatOk =
          !hasServiceCategoryScope ||
          coupon.serviceCategoryIds!.includes(serviceCategoryById.get(line.serviceId) ?? '');
        const svcOk = !hasServiceScope || coupon.serviceIds!.includes(line.serviceId);
        const itemCatOk =
          !hasItemCategoryScope ||
          coupon.itemCategoryIds!.includes(itemCategoryById.get(line.itemId) ?? '');
        const itemOk = !hasItemScope || coupon.itemIds!.includes(line.itemId);
        if (svcCatOk && svcOk && itemCatOk && itemOk) qualifyingItemIndexes.push(idx);
      });
    }

    if (!qualifyingItemIndexes.length) {
      return fail("This coupon doesn't apply to any item in this order.");
    }

    const eligibleSubtotal = roundRupee(
      qualifyingItemIndexes.reduce((sum, idx) => sum + (Number(input.items[idx].totalPrice) || 0), 0),
    );

    let discountAmount: number;
    if (coupon.discountType === CouponDiscountType.PERCENTAGE) {
      discountAmount = roundRupee((eligibleSubtotal * coupon.discountValue) / 100);
      if (coupon.maxDiscountAmount != null) {
        discountAmount = Math.min(discountAmount, roundRupee(coupon.maxDiscountAmount));
      }
    } else if (coupon.discountType === CouponDiscountType.CHEAPEST_ITEM_FREE) {
      // Counted by quantity, not by line — a qualifying qty-3 line is 3
      // items toward the minimum, same granularity used to find the
      // cheapest unit below.
      const qualifyingUnitCount = qualifyingItemIndexes.reduce(
        (sum, idx) => sum + (Number(input.items[idx].quantity) || 0),
        0,
      );
      const minRequired = coupon.minQualifyingItems && coupon.minQualifyingItems > 0 ? coupon.minQualifyingItems : 1;
      if (qualifyingUnitCount < minRequired) {
        return fail(`This coupon needs at least ${minRequired} qualifying item(s) in the order.`);
      }

      // Per-unit price of each qualifying line (totalPrice is the whole
      // line, quantity included — units within one line share the same
      // price, so comparing per-line per-unit prices is equivalent to
      // comparing every individual unit without actually expanding the
      // list). The cheapest single unit anywhere in scope is freed.
      let cheapestUnitPrice = Infinity;
      for (const idx of qualifyingItemIndexes) {
        const line = input.items[idx];
        const qty = Number(line.quantity) || 0;
        if (qty <= 0) continue;
        const unitPrice = Number(line.totalPrice) / qty;
        if (unitPrice < cheapestUnitPrice) cheapestUnitPrice = unitPrice;
      }
      discountAmount = Number.isFinite(cheapestUnitPrice) ? Math.round(cheapestUnitPrice * 100) / 100 : 0;
    } else {
      discountAmount = Math.min(roundRupee(coupon.discountValue), eligibleSubtotal);
    }

    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      name: coupon.name,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      eligibleSubtotal,
      discountAmount,
      qualifyingItemIndexes,
    };
  }

  /**
   * Resolves an influencer-shared referral code to the coupon it's assigned
   * to — called at registration time, by CustomerAuthController.register()
   * (public self-registration) and CustomerController.create() (admin
   * panel), before the new Customer row is created. Only ever matches an
   * isReferralCode coupon; a normal checkout coupon's code is never valid
   * here (and a referral coupon's code is never valid at checkout — see
   * evaluate()'s allowReferralCoupon guard above). Returns null when
   * nothing valid matches (wrong code, inactive, deleted, outside its
   * validity window, or not actually a referral coupon) — both current
   * callers reject registration outright on null rather than silently
   * proceeding without attaching it.
   */
  async resolveReferralCoupon(referralCode: string): Promise<Coupon | null> {
    const normalizedCode = referralCode.trim().toUpperCase();
    if (!normalizedCode) return null;
    const coupon = await this.couponRepo.findOne({
      where: {code: normalizedCode, isReferralCode: true, isActive: true, isDeleted: false} as object,
    });
    if (!coupon) return null;
    if (!this.isWithinValidityWindow(coupon)) return null;
    return coupon;
  }

  /**
   * Auto-applies a customer's attached referral coupon (see
   * resolveReferralCoupon / Customer.referredByCouponId) — called by
   * OrderService.createOrder only on a customer's very first order, and
   * only when no coupon code was explicitly provided (an explicit code
   * always wins, same "does not stack" rule as the standing discount).
   * Returns undefined when the customer has no referral coupon attached,
   * or when it exists but doesn't evaluate cleanly against this order
   * (wrong scope, expired, usage cap already spent) — unlike a manually-
   * typed code, a referral mismatch is never surfaced as an error; the
   * caller just falls back to the customer's standing discount instead.
   */
  async evaluateReferralCoupon(
    customer: Customer,
    storeId: string,
    items: CouponEvaluationItem[],
  ): Promise<CouponEvaluationSuccess | undefined> {
    if (!customer.referredByCouponId) return undefined;
    const coupon = await this.couponRepo.findOne({
      where: {id: customer.referredByCouponId, isActive: true, isDeleted: false} as object,
    });
    if (!coupon) return undefined;

    const evaluation = await this.evaluate({
      couponCode: coupon.code,
      customerId: customer.id,
      storeId,
      items,
      allowReferralCoupon: true,
    });
    return evaluation.valid ? evaluation : undefined;
  }

  /**
   * Home-screen "active offers" list — every currently active, date-valid,
   * usage-available, audience-eligible coupon for this customer. No cart
   * exists yet, so item/service scope and discount amount are irrelevant
   * here; a coupon with any geo scope is excluded entirely when storeId
   * can't be resolved (can't verify it, so don't show it) — geo-unscoped
   * coupons always show regardless of storeId.
   */
  async listEligibleForDisplay(customerId: string, storeId?: string): Promise<EligibleCouponDisplay[]> {
    const candidates = await this.couponRepo.find({where: {isActive: true, isDeleted: false} as object});

    const eligible: EligibleCouponDisplay[] = [];
    for (const coupon of candidates) {
      // Referral coupons are never browsable/manually-appliable — they only
      // ever get attached via registration (resolveReferralCoupon below)
      // and auto-apply on that customer's first order.
      if (coupon.isReferralCode) continue;
      if (!this.isWithinValidityWindow(coupon)) continue;
      if (await this.usageCapacityReason(coupon, customerId)) continue;

      const hasGeoScope =
        (coupon.storeIds?.length ?? 0) > 0 ||
        (coupon.clusterIds?.length ?? 0) > 0 ||
        (coupon.regionIds?.length ?? 0) > 0;
      if (hasGeoScope) {
        if (!storeId) continue;
        if (await this.geoScopeReason(coupon, storeId)) continue;
      }

      if (await this.audienceScopeReason(coupon, customerId)) continue;

      eligible.push({
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        description: coupon.description,
        colorTag: coupon.colorTag,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscountAmount: coupon.maxDiscountAmount,
        minQualifyingItems: coupon.minQualifyingItems,
        endDate: coupon.endDate,
      });
    }
    return eligible;
  }

  private isWithinValidityWindow(coupon: Coupon): boolean {
    const now = new Date();
    const start = new Date(coupon.startDate);
    const end = new Date(coupon.endDate);
    end.setHours(23, 59, 59, 999); // endDate is inclusive through end of day
    return now >= start && now <= end;
  }

  private async usageCapacityReason(coupon: Coupon, customerId: string): Promise<string | null> {
    if (coupon.maxUsesTotal != null && (coupon.totalUsesCount ?? 0) >= coupon.maxUsesTotal) {
      return 'This coupon has reached its usage limit.';
    }
    if (coupon.maxUsesPerCustomer != null) {
      const usedByCustomer = await this.couponRedemptionRepo.count({
        couponId: coupon.id,
        customerId,
        isReversed: false,
      } as object);
      if (usedByCustomer.count >= coupon.maxUsesPerCustomer) {
        return "You've already used this coupon the maximum number of times.";
      }
    }
    return null;
  }

  // Geo: store -> cluster -> region.
  private async geoScopeReason(coupon: Coupon, storeId: string): Promise<string | null> {
    if (
      (coupon.storeIds?.length ?? 0) === 0 &&
      (coupon.clusterIds?.length ?? 0) === 0 &&
      (coupon.regionIds?.length ?? 0) === 0
    ) {
      return null;
    }

    const store = await this.storeRepo.findOne({where: {id: storeId} as object});
    if (!store) return 'Store not found.';
    if ((coupon.storeIds?.length ?? 0) > 0 && !coupon.storeIds!.includes(store.id)) {
      return 'This coupon is not valid at this store.';
    }
    if (
      (coupon.clusterIds?.length ?? 0) > 0 &&
      !(store.clusterId && coupon.clusterIds!.includes(store.clusterId))
    ) {
      return 'This coupon is not valid at this store.';
    }
    if ((coupon.regionIds?.length ?? 0) > 0) {
      const cluster = store.clusterId
        ? await this.clusterRepo.findOne({where: {id: store.clusterId} as object})
        : null;
      if (!cluster || !coupon.regionIds!.includes(cluster.regionId)) {
        return 'This coupon is not valid at this store.';
      }
    }
    return null;
  }

  // Audience: label OR individual grant (either qualifies).
  private async audienceScopeReason(coupon: Coupon, customerId: string): Promise<string | null> {
    const hasLabelScope = (coupon.customerLabelIds?.length ?? 0) > 0;
    const individualCount = await this.couponCustomerRepo.count({
      couponId: coupon.id,
      isDeleted: false,
    } as object);
    if (!hasLabelScope && individualCount.count === 0) return null;

    let eligible = false;
    if (hasLabelScope) {
      const labelMatch = await this.customerLabelAssignmentRepo.findOne({
        where: {
          customerId,
          customerLabelId: {inq: coupon.customerLabelIds},
          isDeleted: false,
        } as object,
      });
      eligible = Boolean(labelMatch);
    }
    if (!eligible && individualCount.count > 0) {
      const individualMatch = await this.couponCustomerRepo.findOne({
        where: {couponId: coupon.id, customerId, isDeleted: false} as object,
      });
      eligible = Boolean(individualMatch);
    }
    return eligible ? null : "You're not eligible for this coupon.";
  }
}
