import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Store} from './store.model';

// One row per (store, year, month) — the year is part of the key on
// purpose: editing a store's November 2026 targets must never touch its
// November 2025 row (and whatever reports already ran against it), so
// "this month" is never shared across years.
@model({
  settings: {
    postgresql: {
      table: 'store_monthly_target',
      schema: 'public',
    },
    indexes: {
      uniqueStoreMonthlyTarget: {
        keys: {storeId: 1, year: 1, month: 1},
        options: {unique: true},
      },
    },
  },
})
export class StoreMonthlyTarget extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Store)
  storeId: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'integer'},
  })
  year: number;

  // 1-12
  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'integer'},
  })
  month: number;

  @property({
    type: 'number',
    postgresql: {dataType: 'integer'},
    jsonSchema: {nullable: true, minimum: 0, multipleOf: 1},
  })
  itemTarget?: number | null;

  @property({
    type: 'number',
    postgresql: {dataType: 'integer'},
    jsonSchema: {nullable: true, minimum: 0, multipleOf: 1},
  })
  serviceTarget?: number | null;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
    jsonSchema: {nullable: true, minimum: 0},
  })
  revenueTarget?: number | null;

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

  constructor(data?: Partial<StoreMonthlyTarget>) {
    super(data);
  }
}

export interface StoreMonthlyTargetRelations {
  store?: Store;
}

export type StoreMonthlyTargetWithRelations = StoreMonthlyTarget &
  StoreMonthlyTargetRelations;
