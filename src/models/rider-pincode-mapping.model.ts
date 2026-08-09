import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Rider} from './rider.model';

/**
 * One row per (rider, pincode) pair — a rider can cover several pincodes,
 * but a pincode can only be covered by one active rider at a time
 * (enforced in the controller via assertPincodeFree, not a DB constraint —
 * no partial-unique-index precedent exists elsewhere in this codebase).
 */
@model({
  settings: {
    postgresql: {table: 'rider_pincode_mapping', schema: 'public'},
  },
})
export class RiderPincodeMapping extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => Rider)
  riderId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {pattern: '^[0-9]{6}$'},
  })
  pincode: string;

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

  constructor(data?: Partial<RiderPincodeMapping>) {
    super(data);
  }
}

export interface RiderPincodeMappingRelations {
  rider?: Rider;
}

export type RiderPincodeMappingWithRelations = RiderPincodeMapping & RiderPincodeMappingRelations;
