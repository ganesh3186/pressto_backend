import {Entity, model, property} from '@loopback/repository';

// Which additional services (e.g. hand-wash) were selected for this
// specific garment — not the whole order line. Amount is frozen at the
// price resolved when the order was created, mirroring
// OrderItemAdditionalCharge, so later catalog price changes don't drift
// historical orders.
@model({
  settings: {postgresql: {table: 'garment_additional_service', schema: 'public'}},
})
export class GarmentAdditionalService extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  serviceId: string;

  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentAdditionalService>) {
    super(data);
  }
}

export interface GarmentAdditionalServiceRelations {}
export type GarmentAdditionalServiceWithRelations = GarmentAdditionalService & GarmentAdditionalServiceRelations;
