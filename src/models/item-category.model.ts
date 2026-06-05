import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'item_category',
      schema: 'public',
    },
    indexes: {
      uniqueItemCategoryCode: {
        keys: ['code'],
        options: {
          unique: true,
        },
      },
    }
  },
})
export class ItemCategory extends Entity {
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
    required: true
  })
  code: string;

  @property({
    type: 'string',
  })
  description?: string;

  @property({
    type: 'boolean',
    default: true,
  })
  isActive?: boolean;

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

  constructor(data?: Partial<ItemCategory>) {
    super(data);
  }
}

export interface ItemCategoryRelations {
  // describe navigational properties here
}

export type ItemCategoryWithRelations = ItemCategory & ItemCategoryRelations;
