import { Entity, model, property } from '@loopback/repository';
import { BagStatus } from './bag-status.enum';

@model({
  settings: {
    postgresql: {
      table: 'bag',
      schema: 'public',
    },
    indexes: {
      uniqueBagNumber: {
        keys: ['bagNumber'],
        options: {
          unique: true,
        },
      }
    }
  },
})
export class Bag extends Entity {
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
    type: 'number',
    required: true,
  })
  bagNumber: number;

  @property({
    type: 'boolean',
    default: true,
  })
  isActive?: boolean;

  // ── Interstore Transfer custody (added for the Transfer feature —
  // garment-actions.controller.ts's changeBag() never reads these) ──
  @property({
    type: 'string',
    default: BagStatus.AVAILABLE,
    jsonSchema: { enum: Object.values(BagStatus) },
  })
  status?: BagStatus;

  @property({ type: 'number', default: 25 })
  maxCapacity?: number;

  @property({ type: 'number', default: 0 })
  itemCount?: number;

  // Denormalized display convenience only — while IN_USE, the bag's real
  // location is authoritative via TransferCustodyEvent, not this field.
  @property({ type: 'string', postgresql: { dataType: 'uuid' } })
  currentStoreId?: string;

  // The open Transfer this bag is locked to. Null when AVAILABLE.
  @property({ type: 'string', postgresql: { dataType: 'uuid' } })
  currentTransferId?: string;

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

  constructor(data?: Partial<Bag>) {
    super(data);
  }
}

export interface BagRelations { }

export type BagWithRelations = Bag & BagRelations;
