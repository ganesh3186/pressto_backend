import {belongsTo, Entity, model, property} from '@loopback/repository';
import {Coupon, CouponPricingSnapshot} from './coupon.model';
import {Customer} from './customer.model';
import {Order} from './order.model';

// Redemption record — one per (order, coupon) pair; an order that
// combined several coupons (OrderService.createOrder's couponCodes) gets
// one row per coupon. Authoritative record of "who used what coupon, on
// which order, for how much", used to enforce maxUsesPerCustomer/
// maxUsesTotal and to power the admin redemption-history view.
// Draft edits reverse the previous selection before recording the replacement.
@model({
  settings: {
    postgresql: {table: 'coupon_redemption', schema: 'public'},
  },
})
export class CouponRedemption extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Coupon)
  couponId: string;

  // Frozen at redemption time — same snapshot precedent as
  // Order.deliveryAddress — survives even if the coupon's code is later
  // edited.
  @property({type: 'string', required: true})
  couponCodeSnapshot: string;

  @belongsTo(() => Customer)
  customerId: string;

  @belongsTo(() => Order)
  orderId: string;

  // Snapshot of Coupon.discountType at redemption time.
  @property({type: 'string', required: true})
  discountType: string;

  // Current rupee amount deducted; bookingSnapshot preserves the original.
  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  discountAmount: number;

  @property({type: 'object', postgresql: {dataType: 'jsonb'}})
  bookingSnapshot?: {bookedDiscountAmount: number; coupon?: CouponPricingSnapshot};

  @property({type: 'boolean', default: false})
  isReversed?: boolean;

  @property({type: 'boolean', default: false})
  isProvisional?: boolean;

  @property({type: 'date'})
  reversedAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<CouponRedemption>) {
    super(data);
  }
}

export interface CouponRedemptionRelations {}

export type CouponRedemptionWithRelations = CouponRedemption & CouponRedemptionRelations;
