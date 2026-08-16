import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {CouponDiscountType} from '../models/coupon-discount-type.enum';
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

    const now = new Date();
    const start = new Date(coupon.startDate);
    const end = new Date(coupon.endDate);
    end.setHours(23, 59, 59, 999); // endDate is inclusive through end of day
    if (now < start || now > end) return fail('This coupon is not currently valid.');

    if (coupon.maxUsesTotal != null && (coupon.totalUsesCount ?? 0) >= coupon.maxUsesTotal) {
      return fail('This coupon has reached its usage limit.');
    }

    if (coupon.maxUsesPerCustomer != null) {
      const usedByCustomer = await this.couponRedemptionRepo.count({
        couponId: coupon.id,
        customerId: input.customerId,
        isReversed: false,
      } as object);
      if (usedByCustomer.count >= coupon.maxUsesPerCustomer) {
        return fail("You've already used this coupon the maximum number of times.");
      }
    }

    // Geo: store -> cluster -> region.
    if (
      (coupon.storeIds?.length ?? 0) > 0 ||
      (coupon.clusterIds?.length ?? 0) > 0 ||
      (coupon.regionIds?.length ?? 0) > 0
    ) {
      const store = await this.storeRepo.findOne({where: {id: input.storeId} as object});
      if (!store) return fail('Store not found.');
      if ((coupon.storeIds?.length ?? 0) > 0 && !coupon.storeIds!.includes(store.id)) {
        return fail('This coupon is not valid at this store.');
      }
      if (
        (coupon.clusterIds?.length ?? 0) > 0 &&
        !(store.clusterId && coupon.clusterIds!.includes(store.clusterId))
      ) {
        return fail('This coupon is not valid at this store.');
      }
      if ((coupon.regionIds?.length ?? 0) > 0) {
        const cluster = store.clusterId
          ? await this.clusterRepo.findOne({where: {id: store.clusterId} as object})
          : null;
        if (!cluster || !coupon.regionIds!.includes(cluster.regionId)) {
          return fail('This coupon is not valid at this store.');
        }
      }
    }

    // Audience: label OR individual grant (either qualifies).
    const hasLabelScope = (coupon.customerLabelIds?.length ?? 0) > 0;
    const individualCount = await this.couponCustomerRepo.count({
      couponId: coupon.id,
      isDeleted: false,
    } as object);
    if (hasLabelScope || individualCount.count > 0) {
      let eligible = false;
      if (hasLabelScope) {
        const labelMatch = await this.customerLabelAssignmentRepo.findOne({
          where: {
            customerId: input.customerId,
            customerLabelId: {inq: coupon.customerLabelIds},
            isDeleted: false,
          } as object,
        });
        eligible = Boolean(labelMatch);
      }
      if (!eligible && individualCount.count > 0) {
        const individualMatch = await this.couponCustomerRepo.findOne({
          where: {couponId: coupon.id, customerId: input.customerId, isDeleted: false} as object,
        });
        eligible = Boolean(individualMatch);
      }
      if (!eligible) return fail("You're not eligible for this coupon.");
    }

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
}
