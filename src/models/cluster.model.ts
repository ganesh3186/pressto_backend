import { Entity, model, property, belongsTo } from '@loopback/repository';
import { Region } from './region.model';

@model({
  settings: {
    postgresql: {
      table: 'cluster',
      schema: 'public',
    },
    indexes: {
      uniqueClusterCode: {
        keys: ['code'],
        options: { unique: true },
      },
    },
  },
})
export class Cluster extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: { dataType: 'uuid' },
  })
  id: string;

  @belongsTo(() => Region)
  regionId: string;

  @property({ type: 'string', required: true })
  name: string;

  @property({ type: 'string', required: true })
  code: string;

  @property({ type: 'string', required: true })
  clusterType: string;

  @property({
    type: 'array',
    itemType: 'number',
    required: false,
    postgresql: { dataType: 'jsonb' },
  })
  pincodes?: number[];

  @property({ type: 'string' })
  description?: string;

  @property({ type: 'boolean', default: true })
  isActive?: boolean;

  @property({ type: 'boolean', default: false })
  isDeleted?: boolean;

  @property({ type: 'date', defaultFn: 'now' })
  createdAt?: Date;

  @property({ type: 'date', defaultFn: 'now' })
  updatedAt?: Date;

  @property({ type: 'date' })
  deletedAt?: Date;

  constructor(data?: Partial<Cluster>) {
    super(data);
  }
}

export interface ClusterRelations { }

export type ClusterWithRelations = Cluster & ClusterRelations;
