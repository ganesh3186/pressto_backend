import {Entity, hasMany, model, property} from '@loopback/repository';
import {GarmentStainImage} from './garment-stain-image.model';

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

  @property({type: 'string', postgresql: {dataType: 'text'}})
  remarks?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @hasMany(() => GarmentStainImage)
  images: GarmentStainImage[];

  constructor(data?: Partial<GarmentStain>) {
    super(data);
  }
}

export interface GarmentStainRelations {
  images?: GarmentStainImage[];
}

export type GarmentStainWithRelations = GarmentStain & GarmentStainRelations;
