import {Entity, model, property, belongsTo} from '@loopback/repository';
import {GarmentDamage} from './garment-damage.model';
import {Media} from './media.model';

@model({
  settings: {postgresql: {table: 'garment_damage_image', schema: 'public'}},
})
export class GarmentDamageImage extends Entity {
  @property({type: 'string', id: true, generated: false, postgresql: {dataType: 'uuid'}})
  id: string;

  @belongsTo(() => GarmentDamage)
  garmentDamageId: string;

  @belongsTo(() => Media)
  mediaId: string;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  constructor(data?: Partial<GarmentDamageImage>) {
    super(data);
  }
}

export interface GarmentDamageImageRelations {
  garmentDamage?: GarmentDamage;
  media?: Media;
}

export type GarmentDamageImageWithRelations = GarmentDamageImage & GarmentDamageImageRelations;
