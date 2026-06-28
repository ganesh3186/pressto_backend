import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Cluster} from './cluster.model';

@model({
  settings: {
    postgresql: {
      table: 'cluster_price_list',
      schema: 'public',
    },
  },
})
export class ClusterPriceList extends Entity {
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

  @belongsTo(() => Cluster)
  clusterId: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  percentage: number;

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

  constructor(data?: Partial<ClusterPriceList>) {
    super(data);
  }
}

export interface ClusterPriceListRelations {
  cluster?: Cluster;
}

export type ClusterPriceListWithRelations = ClusterPriceList & ClusterPriceListRelations;
