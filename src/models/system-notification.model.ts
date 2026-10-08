import {Entity, model, property, belongsTo} from '@loopback/repository';
import {Users} from './users.model';

@model({
  settings: {
    postgresql: {
      table: 'system_notification',
      schema: 'public',
    },
  },
})
export class SystemNotification extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {
      dataType: 'uuid',
    },
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
  })
  title: string;

  @property({
    type: 'string',
    required: true,
  })
  body: string;

  @property({
    type: 'string',
    required: true,
  })
  template: string;

  @property({
    type: 'string',
  })
  pathname?: string;

  @property({
    type: 'number',
    default: 0,
  })
  status?: number; // 0: unRead, 1: Read

  @property({
    type: 'object',
    postgresql: {
      dataType: 'jsonb',
    },
  })
  extraDetails?: object;

  @property({
    type: 'string',
  })
  remark?: string;

  @belongsTo(() => Users)
  userId: string;

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

  constructor(data?: Partial<SystemNotification>) {
    super(data);
  }
}

export interface SystemNotificationRelations {
  user?: Users;
}

export type SystemNotificationWithRelations = SystemNotification & SystemNotificationRelations;
