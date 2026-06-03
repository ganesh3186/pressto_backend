import {Entity, model, property} from '@loopback/repository';

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
    postgresql: {
      dataType: 'uuid',
    },
  })
  id: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  priceListId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  serviceId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  itemId: string;

  @property({
    type: 'number',
    postgresql: {dataType: 'numeric'},
  })
  price?: number;

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

  constructor(data?: Partial<PriceListItem>) {
    super(data);
  }
}

export interface PriceListItemRelations {
  // describe navigational properties here
}

export type PriceListItemWithRelations = PriceListItem & PriceListItemRelations;
