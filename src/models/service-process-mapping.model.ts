import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Roles} from './roles.model';

@model({
  settings: {
    postgresql: {
      table: 'service_process_mapping',
      schema: 'public',
    },
    indexes: {
      uniqueServiceProcessMapping: {
        keys: {serviceId: 1, processStepId: 1},
        options: {unique: true},
      },
    },
  },
})
export class ServiceProcessMapping extends Entity {
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
  serviceId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  processStepId: string;

  @property({
    type: 'number',
    required: true
  })
  sequence: number;

  @property({
    type: 'boolean',
    default: false
  })
  isInitial: boolean;

  @property({
    type: 'boolean',
    default: false,
  })
  isMandatory?: boolean;

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

  @belongsTo(() => Roles)
  rolesId: string;

  constructor(data?: Partial<ServiceProcessMapping>) {
    super(data);
  }
}

export interface ServiceProcessMappingRelations {
  // describe navigational properties here
}

export type ServiceProcessMappingWithRelations = ServiceProcessMapping &
  ServiceProcessMappingRelations;
