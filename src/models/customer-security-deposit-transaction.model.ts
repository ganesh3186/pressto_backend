import {Entity, belongsTo, model, property} from '@loopback/repository';
import {CustomerSecurityDeposit} from './customer-security-deposit.model';
import {ReferenceType} from './reference-type.enum';
import {SecurityDepositTransactionType} from './security-deposit-transaction-type.enum';

@model({
  settings: {
    postgresql: {
      table: 'customer_security_deposit_transaction',
      schema: 'public',
    },
  },
})
export class CustomerSecurityDepositTransaction extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => CustomerSecurityDeposit)
  securityDepositId: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {
      enum: Object.values(SecurityDepositTransactionType),
    },
  })
  transactionType: SecurityDepositTransactionType;

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

  @property({type: 'date', required: true, defaultFn: 'now'})
  transactionDate: Date;

  @property({type: 'string'})
  remarks?: string;

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

  constructor(data?: Partial<CustomerSecurityDepositTransaction>) {
    super(data);
  }
}

export interface CustomerSecurityDepositTransactionRelations {}

export type CustomerSecurityDepositTransactionWithRelations = CustomerSecurityDepositTransaction & CustomerSecurityDepositTransactionRelations;
