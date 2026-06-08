import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Store} from './store.model';
import {Service} from './service.model';
import {Item} from './item.model';

@model({
  settings: {
    postgresql: {
      table: 'store_price_override',
      schema: 'public',
    },
  },
})
export class StorePriceOverride extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Store)
  storeId: string;

  @belongsTo(() => Service)
  serviceId: string;

  @belongsTo(() => Item)
  itemId: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  overridePrice: number;

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

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  createdBy?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  updatedBy?: string;

  @property({type: 'string', postgresql: {dataType: 'uuid'}})
  deletedBy?: string;

  constructor(data?: Partial<StorePriceOverride>) {
    super(data);
  }
}

export interface StorePriceOverrideRelations {}

export type StorePriceOverrideWithRelations = StorePriceOverride & StorePriceOverrideRelations;
