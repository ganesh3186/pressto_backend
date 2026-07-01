import {Entity, model, property, belongsTo} from '@loopback/repository';
import {GarmentStain} from './garment-stain.model';
import {Media} from './media.model';

@model({
  settings: {postgresql: {table: 'garment_stain_image', schema: 'public'}},
})
export class GarmentStainImage extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => GarmentStain)
  garmentStainId: string;

  @belongsTo(() => Media)
  mediaId: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentStainImage>) {
    super(data);
  }
}

export interface GarmentStainImageRelations {
  garmentStain?: GarmentStain;
  media?: Media;
}

export type GarmentStainImageWithRelations = GarmentStainImage & GarmentStainImageRelations;
