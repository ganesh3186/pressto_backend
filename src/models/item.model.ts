import { Entity, model, property, belongsTo, hasMany} from '@loopback/repository';
import { Media } from './media.model';
import {ItemCategory} from './item-category.model';
import {Service} from './service.model';
import {ServiceItemMapping} from './service-item-mapping.model';

@model({
  settings: {
    postgresql: {
      table: 'item',
      schema: 'public',
    },
  },
})
export class Item extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {
      dataType: 'uuid',
    },
  })
  id: string;
  @property({
    type: 'string',
    required: true,
  })
  name: string;

  @property({
    type: 'string',
  })
  code?: string;

  @property({
    type: 'string',
  })
  description?: string;

  @belongsTo(() => Media)
  mediaId: string;

  @property({
    type: 'boolean',
    default: false,
  })
  isMeasurement: boolean;

  @property({
    type: 'boolean',
    default: true,
  })
  isActive?: boolean;

  @property({
    type: 'number',
  })
  status?: number;

  @property({
    type: 'boolean',
    default: false,
  })
  isDeleted?: boolean;

  @property({
    type: 'date',
    defaultFn: 'now',
  })
  createdAt?: Date;

  @property({
    type: 'date',
    defaultFn: 'now',
  })
  updatedAt?: Date;

  @property({
    type: 'date',
  })
  deletedAt?: Date;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  createdBy?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  updatedBy?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  deletedBy?: string;

  @belongsTo(() => ItemCategory)
  itemCategoryId: string;

  @hasMany(() => Service, {through: {model: () => ServiceItemMapping}})
  services: Service[];

  constructor(data?: Partial<Item>) {
    super(data);
  }
}

export interface ItemRelations {
  // describe navigational properties here
}

export type ItemWithRelations = Item & ItemRelations;
