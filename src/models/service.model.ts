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

  // Manual display order in POS (ascending). Null/0 falls back to alphabetical.
  @property({
    type: 'number',
    default: 0,
  })
  sequence?: number;

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

  // independent = selectable as an order item's primary service (main "Service"
  // dropdown). dependent = selectable only as an additional service — never shows
  // as a primary-service option.
  @property({
    type: 'string',
    default: 'independent',
    jsonSchema: {enum: ['independent', 'dependent']},
  })
  dependencyType?: string;

  // Whether this service, used as a primary service, has its own process/TAT.
  // false means the order item does nothing on its own — it's a shell that only
  // has real work once an additional service is attached (e.g. Presstoke, Repair,
  // CC-Repair). Only meaningful when dependencyType is 'independent'.
  @property({
    type: 'boolean',
    default: true,
  })
  hasOwnProcess?: boolean;

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
