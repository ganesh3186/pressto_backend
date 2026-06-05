import { Entity, model, property, belongsTo, hasMany} from '@loopback/repository';
import {ServiceCategory} from './service-category.model';
import {Media} from './media.model';
import {Item} from './item.model';
import {ServiceItemMapping} from './service-item-mapping.model';
import {ProcessStep} from './process-step.model';
import {ServiceProcessMapping} from './service-process-mapping.model';

@model({
  settings: {
    postgresql: {
      table: 'service',
      schema: 'public',
    },
    indexes: {
      uniqueServiceCode: {
        keys: ['code'],
        options: {
          unique: true,
        },
      },
    }
  },
})
export class Service extends Entity {
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
    type: 'number',
    required: true
  })
  estimatedDurationInHours: number;

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

  @belongsTo(() => Media)
  mediaId: string;

  @belongsTo(() => ServiceCategory)
  serviceCategoryId: string;

  @hasMany(() => Item, {through: {model: () => ServiceItemMapping}})
  items: Item[];

  @hasMany(() => ProcessStep, {through: {model: () => ServiceProcessMapping}})
  processSteps: ProcessStep[];

  constructor(data?: Partial<Service>) {
    super(data);
  }
}

export interface ServiceRelations {
  // describe navigational properties here
}

export type ServiceWithRelations = Service & ServiceRelations;
