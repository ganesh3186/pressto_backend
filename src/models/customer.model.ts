import {Entity, belongsTo, hasMany, model, property} from '@loopback/repository';
import {Users} from './users.model';
import {CustomerLabel} from './customer-label.model';
import {CustomerLabelAssignment} from './customer-label-assignment.model';
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

  // On-account billing eligibility. A `business` customer is ALWAYS eligible
  // regardless of this flag (checked separately wherever eligibility is
  // gated) — this exists so an `individual` customer can also be opted in,
  // since there's nothing to derive that from automatically the way there is
  // for business customers.
  @property({type: 'boolean', default: false})
  isOnAccountEligible?: boolean;

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

  // Deprecated: a customer used to carry exactly one label via this FK.
  // Replaced by the customerLabels many-to-many below (see
  // CustomerLabelAssignment). Left on the model — and the DB column left in
  // place — only until `node ./dist/copy-customer-labels` has copied every
  // existing value into the new join table; remove this property (and let
  // `npm run migrate` drop the column) once that's confirmed done.
  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  customerLabelId?: string;

  @hasMany(() => CustomerLabel, {through: {model: () => CustomerLabelAssignment}})
  customerLabels: CustomerLabel[];

  constructor(data?: Partial<Customer>) {
    super(data);
  }
}

export interface CustomerRelations {
  user?: Users;
  customerLabels?: CustomerLabel[];
}

export type CustomerWithRelations = Customer & CustomerRelations;
