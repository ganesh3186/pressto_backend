import {Entity, model, property, belongsTo} from '@loopback/repository';
import {PriceList} from './price-list.model';
import {Service} from './service.model';
import {Item} from './item.model';

@model({
  settings: {
    postgresql: {
      table: 'price_list_item',
      schema: 'public',
    },
  },
})
export class PriceListItem extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => PriceList)
  priceListId: string;

  @belongsTo(() => Service)
  serviceId: string;

  @belongsTo(() => Item)
  itemId: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  price: number;

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

  constructor(data?: Partial<PriceListItem>) {
    super(data);
  }
}

export interface PriceListItemRelations {}

export type PriceListItemWithRelations = PriceListItem & PriceListItemRelations;
