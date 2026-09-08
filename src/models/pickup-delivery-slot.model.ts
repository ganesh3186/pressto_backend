import {Entity, model, property} from '@loopback/repository';
import {PickupDeliverySlotType} from './pickup-delivery-slot-type.enum';

/**
 * Master list of pickup/delivery time windows (e.g. "9:00 AM - 12:00 PM").
 * PickupRequest.slotId / Order.deliverySlotId reference this by id; both
 * models also keep a denormalized `slot`/`deliverySlot` text snapshot of
 * `label`, resolved once at write time — same pattern as Transfer's store
 * name snapshots.
 */
@model({
  settings: {
    postgresql: {table: 'pickup_delivery_slot', schema: 'public'},
  },
})
export class PickupDeliverySlot extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true})
  label: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(PickupDeliverySlotType)},
  })
  type: PickupDeliverySlotType;

  // Free "HH:mm" strings — no time-of-day type precedent exists elsewhere
  // in this codebase (PickupRequest.slot/Order.deliverySlot are both plain
  // strings too).
  @property({type: 'string', required: true})
  startTime: string;

  @property({type: 'string', required: true})
  endTime: string;

  @property({type: 'number', default: 0})
  sortOrder?: number;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  // When true, this slot is only offered in the admin panel's own pickup/
  // delivery scheduling (Generate Request, Assign Rider, Dispatch, the
  // order-details delivery dialog) — hidden from the rider app's
  // GET /rider/pickup-slots and the customer app's
  // GET /profile/customer/pickup-slots, and rejected if either tries to
  // book it directly by id.
  @property({type: 'boolean', default: false})
  isAdminOnly?: boolean;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  constructor(data?: Partial<PickupDeliverySlot>) {
    super(data);
  }
}

export interface PickupDeliverySlotRelations {}
export type PickupDeliverySlotWithRelations = PickupDeliverySlot & PickupDeliverySlotRelations;
