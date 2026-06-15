import {Entity, belongsTo, model, property} from '@loopback/repository';
import {ReferenceType} from './reference-type.enum';
import {Wallet} from './wallet.model';
import {WalletTransactionType} from './wallet-transaction-type.enum';

@model({
  settings: {
    postgresql: {
      table: 'wallet_transaction',
      schema: 'public',
    },
  },
})
export class WalletTransaction extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Wallet)
  walletId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {
      enum: Object.values(WalletTransactionType),
    },
  })
  transactionType: WalletTransactionType;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  amount: number;

  @property({
    type: 'string',
    jsonSchema: {
      enum: Object.values(ReferenceType),
    },
  })
  referenceType?: ReferenceType;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  referenceId?: string;

  @property({type: 'string'})
  remarks?: string;

  @property({type: 'date', required: true, defaultFn: 'now'})
  transactionDate: Date;

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

  constructor(data?: Partial<WalletTransaction>) {
    super(data);
  }
}

export interface WalletTransactionRelations {}

export type WalletTransactionWithRelations = WalletTransaction & WalletTransactionRelations;
