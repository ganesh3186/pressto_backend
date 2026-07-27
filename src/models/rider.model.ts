import {Entity, belongsTo, model, property} from '@loopback/repository';
import {RiderType} from './rider-type.enum';
import {Users} from './users.model';

@model({
  settings: {
    postgresql: {
      table: 'rider',
      schema: 'public',
    },
    indexes: {
      uniqueRiderCode: {
        keys: ['riderCode'],
        options: {unique: true},
      },
      uniqueRiderUserId: {
        keys: ['userId'],
        options: {unique: true},
      },
    },
  },
})
export class Rider extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  // The login account. Phone + email live here; the rider signs in on the rider
  // app by phone + OTP, so the rider must be a Users row like Customer/Employee.
  @belongsTo(() => Users)
  userId: string;

  @property({type: 'string', required: true})
  riderCode: string;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {enum: Object.values(RiderType)},
  })
  riderType: RiderType;

  @property({type: 'string', required: true})
  firstName: string;

  @property({type: 'string', required: true})
  lastName: string;

  // Secondary contact only — not a login identity.
  @property({type: 'string'})
  alternateNumber?: string;

  @property({type: 'string', required: true, postgresql: {dataType: 'text'}})
  address: string;

  @property({type: 'string'})
  doorFloorFlat?: string;

  @property({type: 'string'})
  landmark?: string;

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

  constructor(data?: Partial<Rider>) {
    super(data);
  }
}

export interface RiderRelations {
  user?: Users;
}

export type RiderWithRelations = Rider & RiderRelations;
