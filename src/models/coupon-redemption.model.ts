import {belongsTo, Entity, model, property} from '@loopback/repository';
import {Coupon} from './coupon.model';
import {Customer} from './customer.model';
import {Order} from './order.model';

// Append-only audit row — one per order that used a coupon. Authoritative
// record of "who used what coupon, on which order, for how much", used to
// enforce maxUsesPerCustomer/maxUsesTotal and to power the admin
// redemption-history view. isReversed/reversedAt are reserved for a
// future order-cancellation integration — nothing sets them yet.
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

  // Actual rupee amount deducted on that order.
  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  discountAmount: number;

  @property({type: 'boolean', default: false})
  isReversed?: boolean;

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
