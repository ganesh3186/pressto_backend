import {Entity, belongsTo, model, property} from '@loopback/repository';
import {Users} from './users.model';
import {CustomerLabel} from './customer-label.model';
import {PaymentMode} from './payment-mode.enum';

@model({
  settings: {
    postgresql: {
      table: 'customer',
      schema: 'public',
    },
    indexes: {
      uniqueCustomerCode: {
        keys: ['customerCode'],
        options: {unique: true},
      },
      uniqueCustomerUserId: {
        keys: ['userId'],
        options: {unique: true},
      },
    },
  },
})
export class Customer extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @belongsTo(() => Users)
  userId: string;

  @property({type: 'string', required: true})
  customerCode: string;

  @property({type: 'string', required: true})
  firstName: string;

  @property({type: 'string', required: true})
  lastName: string;

  @property({type: 'string'})
  email?: string;

  @property({type: 'date'})
  dateOfBirth?: Date;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  customerTypeId?: string;

  @property({
    type: 'string',
    default: 'individual',
    jsonSchema: {
      enum: ['individual', 'business'],
    },
  })
  customerEntityType?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  customerGroupId?: string;

  @property({type: 'string'})
  gstNumber?: string;

  @property({type: 'string'})
  panNumber?: string;

  @property({type: 'string'})
  companyName?: string;

  @property({
    type: 'string',
    jsonSchema: {enum: Object.values(PaymentMode)},
  })
  preferredPaymentMode?: PaymentMode;

  @property({type: 'number', default: 0})
  loyaltyPoints?: number;

  @property({type: 'string'})
  defaultDiscountType?: string;

  @property({
    type: 'number',
    postgresql: {dataType: 'decimal'},
  })
  defaultDiscountValue?: number;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  preferredStoreId?: string;

  @property({type: 'number'})
  sensitivityScore?: number;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  notes?: string;

  @property({type: 'boolean', default: true})
  isActive?: boolean;

  @property({type: 'string', postgresql: {dataType: 'text'}})
  statusChangeRemark?: string;

  @property({type: 'boolean', default: false})
  isDeleted?: boolean;

  @property({type: 'date', defaultFn: 'now'})
  createdAt?: Date;

  @property({type: 'date', defaultFn: 'now'})
  updatedAt?: Date;

  @property({type: 'date'})
  deletedAt?: Date;

  @belongsTo(() => CustomerLabel)
  customerLabelId: string;

  constructor(data?: Partial<Customer>) {
    super(data);
  }
}

export interface CustomerRelations {
  user?: Users;
}

export type CustomerWithRelations = Customer & CustomerRelations;
