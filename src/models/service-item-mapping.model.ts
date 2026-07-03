import { Entity, model, property } from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'service_item_mapping',
      schema: 'public',
    },
    indexes: {
      uniqueServiceItemMapping: {
        keys: { serviceId: 1, itemId: 1 },
        options: { unique: true },
      },
    }
  },
})
export class ServiceItemMapping extends Entity {
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
    postgresql: { dataType: 'uuid' },
  })
  serviceId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: { dataType: 'uuid' },
  })
  itemId: string;

  @property({
    type: 'number',
    required: true,
    postgresql: { dataType: 'numeric' },
  })
  basePrice: number;

  @property({
    type: 'number',
    postgresql: { dataType: 'numeric' },
  })
  estimatedDurationInDays?: number;

  @property({
    type: 'array',
    itemType: 'string',
    postgresql: {dataType: 'jsonb'},
  })
  additionalServiceIds?: string[];

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

  constructor(data?: Partial<ServiceItemMapping>) {
    super(data);
  }
}

export interface ServiceItemMappingRelations {
  // describe navigational properties here
}

export type ServiceItemMappingWithRelations = ServiceItemMapping &
  ServiceItemMappingRelations;
