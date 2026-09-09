import {Entity, model, property} from '@loopback/repository';
import {DeliveryStatus} from './delivery-status.enum';

/**
 * Header record for one rider's run of customer deliveries — created on
 * every POST /orders/delivery-assignment call, from any caller (Dispatch,
 * Manual Assign). This is what the rider app actually reads
 * (GET /rider/deliveries queries this table by riderId, never
 * Order.assignedRiderId directly), so it always has to exist for an
 * assignment to be visible to the rider at all.
 *
 * bagId is optional — set only when the assignment happened to include a
 * custody bag (adds bag-locking on top); its absence no longer means "no
 * Delivery was created" the way it used to.
 *
 * storeId/riderId/bagId are plain uuid properties, not @belongsTo — same
 * convention as Transfer's fromStoreId/toStoreId/bagId (batch-resolve
 * display names at read time rather than relying on auto `include`).
 *
 * Deliberately holds no per-order status — DeliveryOrder doesn't either.
 * "Is this delivery done" is always answered by reading the linked
 * Orders' own status directly, so the two state machines can't drift.
 */
@model({
  settings: {
    postgresql: {table: 'delivery', schema: 'public'},
    indexes: {
      uniqueDeliveryNumber: {keys: ['deliveryNumber'], options: {unique: true}},
    },
  },
})
export class Delivery extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  // 'DL-{storeCode}-{ddMM}-{seq}' — server-generated, human-readable,
  // matches Transfer.transitId's convention.
  @property({type: 'string', required: true})
  deliveryNumber: string;

  @property({
    type: 'string',
    default: DeliveryStatus.ASSIGNED,
    jsonSchema: {enum: Object.values(DeliveryStatus)},
  })
  status?: DeliveryStatus;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  storeId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  riderId: string;

  @property({type: 'string', required: true})
  riderName: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  bagId?: string;

  @property({type: 'string'})
  deliverySlot?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  deliverySlotId?: string;

  @property({type: 'date'})
  deliveryDate?: Date;

  // Denormalized — manifest size, avoids a count() on every list row.
  @property({type: 'number', default: 0})
  orderCount?: number;

  @property({type: 'date', required: true})
  assignedAt: Date;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  assignedBy: string;

  @property({type: 'date'})
  startedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  startedBy?: string;

  @property({type: 'date'})
  completedAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  completedBy?: string;

  @property({type: 'date'})
  cancelledAt?: Date;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  cancelledBy?: string;

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

  constructor(data?: Partial<Delivery>) {
    super(data);
  }
}

export interface DeliveryRelations {}
export type DeliveryWithRelations = Delivery & DeliveryRelations;
