import {Entity, model, property} from '@loopback/repository';

@model({
  settings: {
    postgresql: {
      table: 'user_roles',
      schema: 'public',
    },
    indexes: {
      uniqueUserRole: {
        keys: {rolesId: 1, usersId: 1},
        options: {unique: true},
      },
    },
  },
})
export class UserRoles extends Entity {
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
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  rolesId: string;

  @property({
    type: 'string',
    required: true,
    postgresql: {dataType: 'uuid'},
  })
  usersId: string;

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
  constructor(data?: Partial<UserRoles>) {
    super(data);
  }
}

export interface UserRolesRelations {
  // describe navigational properties here
}

export type UserRolesWithRelations = UserRoles & UserRolesRelations;
