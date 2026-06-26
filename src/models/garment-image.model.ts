import {Entity, model, property} from '@loopback/repository';
import {GarmentImageType} from './garment-image-type.enum';

@model({
  settings: {postgresql: {table: 'garment_image', schema: 'public'}},
})
export class GarmentImage extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  garmentId: string;

  // References the media record created via file-upload endpoint
  @property({type: 'string', required: true, postgresql: {dataType: 'uuid'}})
  mediaId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(GarmentImageType)},
  })
  imageType: GarmentImageType;

  @property({type: 'string'})
  remarks?: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentImage>) {
    super(data);
  }
}

export interface GarmentImageRelations {}
export type GarmentImageWithRelations = GarmentImage & GarmentImageRelations;
