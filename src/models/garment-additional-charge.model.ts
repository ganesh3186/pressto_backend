import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {postgresql: {table: 'garment_additional_charge', schema: 'public'}},
})
export class GarmentAdditionalCharge extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  additionalChargeId: string;

  // Quantity selected specifically for this garment.
  @property({type: 'number', required: true, default: 1, postgresql: {dataType: 'integer'}})
  quantity: number;

  // Frozen total for this garment selection (unit amount x quantity).
  @property({type: 'number', required: true, postgresql: {dataType: 'numeric'}})
  amount: number;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentAdditionalCharge>) {
    super(data);
  }
}

export interface GarmentAdditionalChargeRelations {}
export type GarmentAdditionalChargeWithRelations = GarmentAdditionalCharge & GarmentAdditionalChargeRelations;
