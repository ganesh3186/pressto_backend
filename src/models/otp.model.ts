import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'otp',
      schema: 'public',
    },
  },
})
export class Otp extends Entity {
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
    type: 'number',
    required: true
  })
  type: number; // 0 => phone, 1=> email

  @property({
    type: 'string',
    required: true
  })
  identifier: string;

  @property({
    type: 'number',
    required: true
  })
  attempts: number;

  @property({
    type: 'date',
    required: true
  })
  expiresAt: Date;

  @property({
    type: 'string',
    required: true
  })
  otp: string;

  @property({
    type: 'boolean',
    default: true,
  })
  isUsed?: boolean;

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
  constructor(data?: Partial<Otp>) {
    super(data);
  }
}

export interface OtpRelations {
  // describe navigational properties here
}

export type OtpWithRelations = Otp & OtpRelations;
