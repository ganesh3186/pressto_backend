import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {postgresql: {table: 'order_item', schema: 'public'}},
})
export class OrderItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  orderId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  serviceId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  itemId: string;

  @property({type: 'number', required: true})
  quantity: number;

  // Raw base price from ServiceItemMapping at time of order (audit trail)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  basePrice?: number;

  // Which price level was applied: store | cluster | region | base
  @property({type: 'string'})
  priceSource?: string;

  // The percentage multiplier applied from the matched price list (null if base)
  @property({type: 'number', postgresql: {dataType: 'numeric'}})
  appliedPercentage?: number;

  // Resolved price after price list (before express multiplier)
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  resolvedPrice?: number;

  // Final unit price = resolvedPrice × expressMultiplier
  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  unitPrice?: number;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  totalPrice?: number;

  // Text part of special instruction for this item
  @property({type: 'string', postgresql: {dataType: 'text'}})
  specialInstructions?: string;

  // Media IDs (uploaded images) attached to this item's special instruction
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  specialInstructionMediaIds?: string[];

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  // Additional services selected for this item (UUIDs of Service records)
  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  additionalServiceIds?: string[];

  // Bridges pricing time (createOrder, before garments necessarily exist)
  // to garment-creation time (which may happen later, e.g. autoCreateGarments
  // for non-store-dropoff orders). One entry per unit — index = unit
  // position within this line — each an array of {serviceId, amount} for
  // that specific unit's selected additional services. Written once at
  // creation, read once per unit when that unit's garment is actually
  // created (persisted onto GarmentAdditionalService), never updated after.
  @property({
    type: 'array',
    itemType: 'object',
    postgresql: {dataType: 'jsonb'},
  })
  pendingUnitAdditionalServices?: Array<Array<{serviceId: string; amount: number}>>;

  // Quantity-aware additional charges selected for each individual garment.
  // Persisted onto GarmentAdditionalCharge when that garment is created.
  @property({
    type: 'array',
    itemType: 'object',
    postgresql: {dataType: 'jsonb'},
  })
  pendingUnitAdditionalCharges?: Array<Array<{
    additionalChargeId: string;
    quantity: number;
    amount: number;
  }>>;

  // Reject-at-intake: the customer brought this piece but it was declined at the
  // counter — recorded so the order shows it came in, priced at ₹0, and never
  // given a garment or put through processing. No approval flow.
  @property({type: 'boolean', default: false})
  rejectedAtIntake?: boolean;

  @property({type: 'string'})
  rejectionReason?: string;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  rejectionRemarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<OrderItem>) {
    super(data);
  }
}

export interface OrderItemRelations {}
export type OrderItemWithRelations = OrderItem & OrderItemRelations;
