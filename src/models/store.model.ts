import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Cluster} from './cluster.model';

@model({
  settings: {
    postgresql: {
      table: 'store',
      schema: 'public',
    },
    indexes: {
      uniqueStoreCode: {
        keys: ['code'],
        options: {unique: true},
      },
    },
  },
})
export class Store extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Cluster)
  clusterId: string;

  @property({type: 'string', required: true})
  name: string;

  @property({type: 'string', required: true})
  code: string;

  @property({type: 'string', required: true})
  storeType: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'text'},
  })
  address: string;

  @property({type: 'string', required: true})
  city: string;

  @property({type: 'string', required: true})
  state: string;

  @property({type: 'string'})
  country?: string;

  @property({type: 'string', required: true})
  pincode: string;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
  })
  latitude?: number;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
  })
  longitude?: number;

  @property({type: 'string'})
  email?: string;

  @property({type: 'string'})
  phone?: string;

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

  constructor(data?: Partial<Store>) {
    super(data);
  }
}

export interface StoreRelations {}

export type StoreWithRelations = Store & StoreRelations;
