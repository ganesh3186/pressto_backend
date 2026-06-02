import { Entity, model, property, hasMany } from '@loopback/repository';
import { Roles } from './roles.model';
import { UserRoles } from './user-roles.model';

@model({
  settings: {
    postgresql: {
      table: 'users',
      schema: 'public',
    },
    indexes: {
      uniqueEmail: {
        keys: { email: 1 },
        options: { unique: true },
      },
      uniquePhone: {
        keys: { phone: 1 },
        options: { unique: true },
      },
    },
  },
})

export class Users extends Entity {
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
    type: 'string'
  })
  fullName?: string;

  @property({
    type: 'string',
    required: true,
  })
  email: string;

  @property({
    type: 'string',
    required: true,
    default: '+91',
  })
  countryCode: string;

  @property({
    type: 'string',
    required: true,
  })
  phone: string;

  @property({
    type: 'string',
  })
  password?: string;

  @property({
    type: 'string',
  })
  resetPasswordOtp?: string;

  @property({
    type: 'date',
  })
  resetPasswordOtpExpires?: Date;

  @property({
    type: 'boolean',
    default: true,
  })
  isActive?: boolean;

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

  @hasMany(() => Roles, { through: { model: () => UserRoles } })
  roles: Roles[];

  constructor(data?: Partial<Users>) {
    super(data);
  }
}

export interface UsersRelations { }

export type UsersWithRelations = Users & UsersRelations;