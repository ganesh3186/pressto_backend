import {Entity, model, property} from '@loopback/repository';
import {CouponDiscountType} from './coupon-discount-type.enum';

/**
 * A discount coupon — code + discount shape + validity window + usage
 * caps, plus up to 8 independent targeting dimensions (service/item
 * category/id, region/cluster/store, customer label), each stored as a
 * jsonb array of ids. Every array is a small, admin-curated set at
 * authoring time — same precedent as Cluster.pincodes — so a plain jsonb
 * column is used rather than a join table per dimension; empty/unset
 * means "no restriction on this dimension" (applies to all).
 *
 * Individual-customer targeting is NOT one of these arrays — see
 * CouponCustomer, a real join table, since that list can be large
 * (CSV-uploaded) and needs indexed per-customer lookups + clean dedupe.
 */
@model({
  settings: {
    postgresql: {table: 'coupon', schema: 'public'},
    indexes: {
      uniqueCouponCode: {keys: ['code'], options: {unique: true}},
    },
  },
})
export class Coupon extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true})
  code: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  description?: string;

  // Free string (hex or named color) — purely a visual tag for the admin
  // coupon list, unrelated to the garment Color master.
  @property({type: 'string'})
  colorTag?: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(CouponDiscountType)},
  })
  discountType: CouponDiscountType;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  discountValue: number;

  // Only meaningful when discountType === percentage — caps the computed
  // discount amount regardless of how large the percentage works out to.
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  maxDiscountAmount?: number;

  // Only meaningful when discountType === cheapest_item_free — the minimum
  // count of qualifying items (by quantity, not by line — a qty-3 line
  // counts as 3) required in the order before the single cheapest one is
  // made free. Unset/0 means no minimum (even a single qualifying item
  // gets freed) — see CouponService.evaluate().
  @property({type: 'number'})
  minQualifyingItems?: number;

  @property({type: 'date', required: true})
  startDate: string;

  @property({type: 'date', required: true})
  endDate: string;

  // null = unlimited. 1 = single-use-per-customer. Together with
  // maxUsesTotal this covers "single use", "multi use", and "frequency of
  // use" as one mechanism — no separate time-gated-reuse concept.
  @property({type: 'number'})
  maxUsesPerCustomer?: number;

  // null = unlimited across all customers.
  @property({type: 'number'})
  maxUsesTotal?: number;

  // Denormalized running count, incremented alongside every
  // CouponRedemption insert in the same transaction — avoids a COUNT(*)
  // on every validate/redeem call.
  @property({type: 'number', default: 0})
  totalUsesCount?: number;

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  serviceCategoryIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  serviceIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  itemCategoryIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  itemIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  regionIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  clusterIds?: string[];

  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  storeIds?: string[];

  // Covers "Labels", "VIP", and "Influencers" as one mechanism — admins
  // create/assign CustomerLabels like "VIP" or "Influencer" through the
  // existing label system, no dedicated fields for either concept here.
  @property({type: 'array', itemType: 'string', postgresql: {dataType: 'jsonb'}})
  customerLabelIds?: string[];

  // Marks this coupon as registration-only: an influencer is handed this
  // coupon's own `code` to share, a new customer supplies it at
  // registration (see CustomerAuthController.register / CustomerController
  // .create), and it's auto-applied to that customer's first order (see
  // OrderService.createOrder) — never manually typed at checkout, never
  // shown in the general browse-offers list. discountType/discountValue
  // work exactly the same as any other coupon; this only changes *how* the
  // coupon gets attached to a customer, not what it discounts.
  @property({type: 'boolean', default: false})
  isReferralCode?: boolean;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  createdBy?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  updatedBy?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<Coupon>) {
    super(data);
  }
}

export interface CouponRelations {}

export type CouponWithRelations = Coupon & CouponRelations;
