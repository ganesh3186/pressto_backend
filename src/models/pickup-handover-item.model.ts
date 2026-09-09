import {Entity, model, property} from '@loopback/repository';

/**
 * One row per PickupRequest included in a PickupHandover batch —
 * normalized join, mirrors RiderCashHandoverItem's role under
 * RiderCashHandover. The service/bag breakdown shown on the app's
 * "Handover orders" screen is read live off each PickupRequest's own
 * actualItemsByService at request time, not re-snapshotted here.
 */
@model({
  settings: {
    postgresql: {table: 'pickup_handover_item', schema: 'public'},
    indexes: {
      pickupRequestLookup: {keys: ['pickupRequestId']},
    },
  },
})
export class PickupHandoverItem extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  pickupHandoverId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  pickupRequestId: string;

  // Denormalized snapshot — safe: PickupRequest.pickupNumber has a unique
  // index and is never reassigned once set.
  @property({type: 'string'})
  pickupNumber?: string;

  @property({type: 'string', required: true})
  customerName: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  constructor(data?: Partial<PickupHandoverItem>) {
    super(data);
  }
}

export interface PickupHandoverItemRelations {}
export type PickupHandoverItemWithRelations = PickupHandoverItem & PickupHandoverItemRelations;
