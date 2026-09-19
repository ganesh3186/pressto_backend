import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'wallet_configuration',
      schema: 'public',
    },
  },
})
export class WalletConfiguration extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  minimumDepositAmount: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  maximumDepositAmount: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  minimumWalletBalance: number;

  @property({
    type: 'number',
    required: true,
    postgresql: {dataType: 'numeric'},
  })
  maximumWalletBalance: number;

  // Auto-discount for paying an order's ENTIRE total via wallet, in one
  // shot, with zero collected via any other mode on that order — see
  // OrderService's payment path. Kept as an explicit on/off switch
  // alongside the percentage (rather than just "0 = off") so the
  // percentage can be temporarily disabled without losing the configured
  // value.
  @property({type: 'boolean', default: false})
  walletDiscountEnabled?: boolean;

  @property({type: 'number', default: 0, postgresql: {dataType: 'numeric'}})
  walletDiscountPercentage?: number;

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

  constructor(data?: Partial<WalletConfiguration>) {
    super(data);
  }
}

export interface WalletConfigurationRelations {}

export type WalletConfigurationWithRelations = WalletConfiguration & WalletConfigurationRelations;
