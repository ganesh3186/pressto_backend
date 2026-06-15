import {Entity, belongsTo, hasMany, model, property} from '@loopback/repository';
import {Customer} from './customer.model';
import {WalletTransaction} from './wallet-transaction.model';

@model({
  settings: {
    postgresql: {
      table: 'wallet',
      schema: 'public',
    },
    indexes: {
      uniqueWalletCustomerId: {
        keys: ['customerId'],
        options: {unique: true},
      },
    },
  },
})
export class Wallet extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Customer)
  customerId: string;

  @property({
    type: 'number',
    default: 0,
    postgresql: {dataType: 'numeric'},
  })
  currentBalance?: number;

  @hasMany(() => WalletTransaction)
  transactions: WalletTransaction[];

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

  constructor(data?: Partial<Wallet>) {
    super(data);
  }
}

export interface WalletRelations {
  customer?: Customer;
  transactions?: WalletTransaction[];
}

export type WalletWithRelations = Wallet & WalletRelations;
