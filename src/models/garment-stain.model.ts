import {Entity, model, property} from '@loopback/repository';
import {Severity} from './severity.enum';

@model({
  settings: {postgresql: {table: 'garment_stain', schema: 'public'}},
})
export class GarmentStain extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  stainId: string;

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

  constructor(data?: Partial<GarmentStain>) {
    super(data);
  }
}

export interface GarmentStainRelations {}
export type GarmentStainWithRelations = GarmentStain & GarmentStainRelations;
