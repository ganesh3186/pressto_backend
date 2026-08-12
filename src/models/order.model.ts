import {Entity, hasMany, model, property} from '@loopback/repository';
import {DeliveryType} from './delivery-type.enum';
import {OrderDeliveryMethod} from './order-delivery-method.enum';
import {OrderLabel} from './order-label.model';
import {OrderLabelAssignment} from './order-label-assignment.model';
import {OrderStatus} from './order-status.enum';
import {OrderType} from './order-type.enum';

@model({
  settings: {
    postgresql: {table: 'orders', schema: 'public'},
    indexes: {
      uniqueOrderNumber: {keys: ['orderNumber'], options: {unique: true}},
    },
  },
})
export class Order extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true})
  orderNumber: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  customerId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  storeId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(OrderType)},
  })
  orderType: OrderType;

  @property({
    type: 'string',
    default: OrderStatus.DRAFT,
    jsonSchema: {enum: Object.values(OrderStatus)},
  })
  status?: OrderStatus;

  // Urgency multiplier selected at order creation (1 = standard, 2 = 2x faster/costlier, etc.)
  @property({type: 'number', default: 1, postgresql: {dataType: 'numeric'}})
  expressMultiplier?: number;

  // Delivery type selected at order creation (standard / express / lightning)
  @property({type: 'string', jsonSchema: {enum: Object.values(DeliveryType)}})
  deliveryType?: DeliveryType;

  // Snapshot of the delivery type percentage at time of order (from DeliveryTypeConfiguration)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  deliveryTypePercentage?: number;

  // Customer contact (person who came on behalf of the customer)
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  customerContactId?: string;

  // For split sub-orders: UUID of the original parent order
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  parentOrderId?: string;

  // For split sub-orders: payment amount allocated from the parent order proportionally
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  allocatedPayment?: number;

  /**
   * Set on a free rework order: the delivered order whose items are being redone
   * because the customer reported a quality problem.
   *
   * Deliberately separate from parentOrderId — a rework order carries ₹0 by
   * design, and counting it as a split child would read as a lost sale.
   */
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  reprocessOfOrderId?: string;

  // Calculated by backend: createdAt + ceil(maxEstimatedDurationInDays / expressMultiplier)
  @property({type: 'date'})
  deliveryDate?: Date;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  subtotal?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  discountAmount?: number;

  @property({type: 'string'})
  discountType?: string;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  taxAmount?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  totalAmount?: number;

  // Text part of order-level special instruction
  @property({type: 'string', postgresql: {dataType: 'text'}})
  specialInstructions?: string;

  // Media IDs (uploaded images) attached to order-level special instruction
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  specialInstructionMediaIds?: string[];

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  // The creating cashier's open POS shift at order-creation time, if one
  // existed — set automatically by OrderService.createOrder(), never
  // client-supplied. Not enforced (an order can still be created with no
  // open shift) — just attribution/audit for when a shift is open.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  shiftId?: string;

  // ── Delivery assignment (home_delivery leg only — see OrderDeliveryMethod's
  // doc comment for why this is never confused with a PickupRequest) ──
  // Not a @belongsTo, matching customerId/storeId's existing plain-uuid style
  // on this model.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  assignedRiderId?: string;

  // Denormalized display snapshot — avoids a join for list views.
  @property({type: 'string'})
  assignedRiderName?: string;

  @property({type: 'string', jsonSchema: {enum: Object.values(OrderDeliveryMethod)}})
  deliveryMethod?: OrderDeliveryMethod;

  // Denormalized display snapshot of deliverySlotId's PickupDeliverySlot.label,
  // resolved server-side when deliverySlotId is supplied. Stays a free
  // string for backward compat with rows/callers that still pass it directly.
  @property({type: 'string'})
  deliverySlot?: string;

  // Authoritative slot reference going forward — plain uuid, matching
  // assignedRiderId/deliveryAddressId's existing style on this model.
  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  deliverySlotId?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  deliveryAddressId?: string;

  // Frozen text snapshot of the address at assignment time, resolved from
  // CustomerAddress — so a later address edit/delete never rewrites order
  // history, same principle as OrderItemAdditionalCharge.amount being
  // frozen at creation.
  @property({type: 'string', postgresql: {dataType: 'text'}})
  deliveryAddress?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  @hasMany(() => OrderLabel, {through: {model: () => OrderLabelAssignment}})
  orderLabels: OrderLabel[];

  constructor(data?: Partial<Order>) {
    super(data);
  }
}

export interface OrderRelations {
  orderLabels?: OrderLabel[];
}
export type OrderWithRelations = Order & OrderRelations;
