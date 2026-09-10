import { Entity, model, property, belongsTo } from '@loopback/repository';
import { Region } from './region.model';

@model({
  settings: {
    postgresql: {
      table: 'warehouse',
      schema: 'public',
    },
    indexes: {
      uniqueWarehouseCode: {
        keys: ['code'],
        options: { unique: true },
      },
    },
  },
})
export class Warehouse extends Entity {
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

  constructor(data?: Partial<Warehouse>) {
    super(data);
  }
}

export interface WarehouseRelations { }

export type WarehouseWithRelations = Warehouse & WarehouseRelations;
