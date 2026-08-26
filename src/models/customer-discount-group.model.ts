import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'customer_discount_group',
      schema: 'public',
    },
    indexes: {
      uniqueCustomerDiscountGroupCode: {
        keys: ['code'],
        options: {unique: true},
      },
    },
  },
})
export class CustomerDiscountGroup extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', required: true})
  code: string;

  @property({type: 'string'})
  description?: string;

  // Auto-applied to every order placed by a customer assigned to this group,
  // unless overridden by a coupon (a coupon replaces this entirely — see
  // OrderService.resolveCustomerAutoDiscount, same non-stacking rule as the
  // customer-level defaultDiscountType/Value override it sits alongside).
  // default: 0 only keeps the migration onto existing rows safe — the
  // controller enforces a real (>0) value on create, see
  // customer-discount-group.controller.ts.
  @property({type: 'number', required: true, default: 0, postgresql: {dataType: 'numeric'}})
  discountPercentage: number;

  // Optional, same purpose as Coupon.maxDiscountAmount — caps the computed
  // discount regardless of how large the percentage works out to.
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  maxDiscountAmount?: number;

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

  constructor(data?: Partial<CustomerDiscountGroup>) {
    super(data);
  }
}

export interface CustomerDiscountGroupRelations {}

export type CustomerDiscountGroupWithRelations = CustomerDiscountGroup & CustomerDiscountGroupRelations;
