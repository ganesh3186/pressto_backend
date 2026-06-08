import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Store} from './store.model';
import {Service} from './service.model';

@model({
  settings: {
    postgresql: {
      table: 'store_service_mapping',
      schema: 'public',
    },
    indexes: {
      uniqueStoreServiceMapping: {
        keys: {storeId: 1, serviceId: 1},
        options: {unique: true},
      },
    },
  },
})
export class StoreServiceMapping extends Entity {
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

  constructor(data?: Partial<StoreServiceMapping>) {
    super(data);
  }
}

export interface StoreServiceMappingRelations {
  store?: Store;
  service?: Service;
}

export type StoreServiceMappingWithRelations = StoreServiceMapping &
  StoreServiceMappingRelations;
