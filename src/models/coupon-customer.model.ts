import {belongsTo, Entity, model, property} from '@loopback/repository';
import {Coupon} from './coupon.model';
import {Customer} from './customer.model';

// Join table for Coupon <-> Customer (many-to-many) — individual
// customers granted access to a coupon, either added one at a time or via
// bulk CSV/XLSX upload. Mirrors CustomerLabelAssignment's shape exactly;
// a real table (not a jsonb array on Coupon) because this list can be
// large and needs indexed per-customer lookups + clean dedupe on re-upload.
@model({
  settings: {
    postgresql: {table: 'coupon_customer', schema: 'public'},
    indexes: {
      uniqueCouponCustomer: {
        keys: {couponId: 1, customerId: 1},
        options: {unique: true},
      },
    },
  },
})
export class CouponCustomer extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Coupon)
  couponId: string;

  @belongsTo(() => Customer)
  customerId: string;

  // Audit only — how this row was added.
  @property({
    type: 'string',
    default: 'manual',
    jsonSchema: {enum: ['manual', 'csv_upload']},
  })
  source?: string;

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

  constructor(data?: Partial<CouponCustomer>) {
    super(data);
  }
}

export interface CouponCustomerRelations {}

export type CouponCustomerWithRelations = CouponCustomer & CouponCustomerRelations;
