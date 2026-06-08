import {Entity, model, property, belongsTo, hasMany} from '@loopback/repository';
import {Region} from './region.model';
import {PriceListItem} from './price-list-item.model';
import {PriceListType} from './price-list-type.enum';

@model({
  settings: {
    postgresql: {
      table: 'price_list',
      schema: 'public',
    },
    indexes: {
      uniquePriceListCode: {
        keys: ['code'],
        options: {unique: true},
      },
    },
  },
})
export class PriceList extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', required: true})
  code: string;

  @belongsTo(() => Region)
  regionId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(PriceListType)},
  })
  priceListType: PriceListType;

  @property({type: 'string'})
  description?: string;

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

  @hasMany(() => PriceListItem)
  priceListItems: PriceListItem[];

  constructor(data?: Partial<PriceList>) {
    super(data);
  }
}

export interface PriceListRelations {
  priceListItems?: PriceListItem[];
}

export type PriceListWithRelations = PriceList & PriceListRelations;
