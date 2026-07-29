import {Entity, hasMany, model, property} from '@loopback/repository';
import {DeliveryType} from './delivery-type.enum';
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
