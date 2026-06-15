import {Entity, belongsTo, hasMany, model, property} from '@loopback/repository';
import {Customer} from './customer.model';
import {CustomerSecurityDepositTransaction} from './customer-security-deposit-transaction.model';
import {SecurityDepositStatus} from './security-deposit-status.enum';

@model({
  settings: {
    postgresql: {
      table: 'customer_security_deposit',
      schema: 'public',
    },
    indexes: {
      uniqueSecurityDepositCustomerId: {
        keys: ['customerId'],
        options: {unique: true},
      },
    },
  },
})
export class CustomerSecurityDeposit extends Entity {
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
  depositAmount?: number;

  @property({
    type: 'number',
    default: 0,
    postgresql: {dataType: 'numeric'},
  })
  availableBalance?: number;

  @property({type: 'date'})
  depositDate?: Date;

  @property({
    type: 'string',
    default: SecurityDepositStatus.ACTIVE,
    jsonSchema: {
      enum: Object.values(SecurityDepositStatus),
    },
  })
  status?: SecurityDepositStatus;

  @property({type: 'string'})
  remarks?: string;

  @hasMany(() => CustomerSecurityDepositTransaction, {keyTo: 'securityDepositId'})
  transactions: CustomerSecurityDepositTransaction[];

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

  constructor(data?: Partial<CustomerSecurityDeposit>) {
    super(data);
  }
}

export interface CustomerSecurityDepositRelations {
  customer?: Customer;
  transactions?: CustomerSecurityDepositTransaction[];
}

export type CustomerSecurityDepositWithRelations = CustomerSecurityDeposit & CustomerSecurityDepositRelations;
