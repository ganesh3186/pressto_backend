import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'registration_sessions',
      schema: 'public',
    },
  },
})
export class RegistrationSessions extends Entity {
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
    type: 'string',
    required: false,
  })
  phoneNumber?: string;

  @property({
    type: 'boolean',
    default: false,
  })
  phoneVerified?: boolean;

  @property({
    type: 'string',
    required: false,
  })
  email?: string;

  @property({
    type: 'boolean',
    default: false,
  })
  emailVerified?: boolean;

  @property({
    type: 'string',
    required: false,
  })
  roleValue?: string;

  @property({
    type: 'date',
    required: true,
  })
  expiresAt: Date;

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

  constructor(data?: Partial<RegistrationSessions>) {
    super(data);
  }
}

export interface RegistrationSessionsRelations { }

export type RegistrationSessionsWithRelations =
  RegistrationSessions & RegistrationSessionsRelations;
