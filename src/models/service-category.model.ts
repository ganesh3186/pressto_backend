import { Entity, model, property, hasMany} from '@loopback/repository';
import {Service} from './service.model';

@model({
  settings: {
    postgresql: {
      table: 'service_category',
      schema: 'public',
    },
    indexes: {
      uniqueServiceCategoryCode: {
        keys: ['code'],
        options: {
          unique: true,
        },
      },
    },
  },
})
export class ServiceCategory extends Entity {
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

  @hasMany(() => Service)
  services: Service[];
  // Indexer property to allow additional data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any;

  constructor(data?: Partial<ServiceCategory>) {
    super(data);
  }
}

export interface ServiceCategoryRelations {
  // describe navigational properties here
}

export type ServiceCategoryWithRelations = ServiceCategory & ServiceCategoryRelations;
