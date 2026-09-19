import {belongsTo, Entity, model, property} from '@loopback/repository';
import {Coupon} from './coupon.model';

// One (serviceId, itemId) -> overridePrice row within a
// CouponDiscountType.PRICE_OVERRIDE coupon — a coupon-scoped mini price
// list. Real table (not a jsonb array on Coupon, unlike the targeting
// dimensions) because a price-override coupon can carry many mappings and
// OrderService.resolvePricing() needs an indexed (serviceId, itemId)
// lookup on every priced line, not a full-array scan.
//
// Mirrors CouponCustomer's shape. Unlike every other coupon type, rows
// here are never touched by CouponService.evaluate() / CouponRedemption —
// a price-override coupon isn't selected or redeemed, it's consulted
// directly inside resolvePricing() the same way store/cluster/region
// pricing already is (see that method's priority-0 check).
@model({
  settings: {
    postgresql: {table: 'coupon_price_override', schema: 'public'},
    indexes: {
      uniqueCouponPriceOverrideMapping: {
        keys: {couponId: 1, serviceId: 1, itemId: 1},
        options: {unique: true},
      },
    },
  },
})
export class CouponPriceOverride extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Coupon)
  couponId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  serviceId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  itemId: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  overridePrice: number;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<CouponPriceOverride>) {
    super(data);
  }
}

export interface CouponPriceOverrideRelations {}

export type CouponPriceOverrideWithRelations = CouponPriceOverride & CouponPriceOverrideRelations;
