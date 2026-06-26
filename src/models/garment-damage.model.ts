import {Entity, model, property} from '@loopback/repository';
import {Severity} from './severity.enum';

@model({
  settings: {postgresql: {table: 'garment_damage', schema: 'public'}},
})
export class GarmentDamage extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  damageTypeId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(Severity)},
  })
  severity: Severity;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentDamage>) {
    super(data);
  }
}

export interface GarmentDamageRelations {}
export type GarmentDamageWithRelations = GarmentDamage & GarmentDamageRelations;
