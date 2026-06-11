import {Entity, hasMany, model, property} from '@loopback/repository';
import {Roles} from './roles.model';
import {RolePermissions} from './role-permissions.model';

@model({
  settings: {
    postgresql: {
      table: 'permissions',
      schema: 'public',
    },
    indexes: {
      uniquePermission: {
        keys: {permission: 1},
        options: {unique: true},
      },
    },
  },
})
export class Permissions extends Entity {
  @property({
    type: 'string',
    id: true,
    generated: false,
    postgresql: {dataType: 'uuid'},
  })
  id: string;

  @property({
    type: 'string',
    required: true,
  })
  permission: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'text'},
  })
  description?: string;

  @property({
    type: 'boolean',
    default: true,
  })
  isActive?: boolean;

  @property({
    type: 'number',
  })
  status?: number;

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

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  createdBy?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  updatedBy?: string;

  @property({
    type: 'string',
    postgresql: {dataType: 'uuid'},
  })
  deletedBy?: string;

  @hasMany(() => Roles, {through: {model: () => RolePermissions}})
  roles: Roles[];

  constructor(data?: Partial<Permissions>) {
    super(data);
  }
}

export interface PermissionsRelations {
  roles?: Roles[];
}
export type PermissionsWithRelations = Permissions & PermissionsRelations;
