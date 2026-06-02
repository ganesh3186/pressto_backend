import {Entity, hasMany, model, property} from '@loopback/repository';
import {Permissions} from './permissions.model';
import {RolePermissions} from './role-permissions.model';
import {UserRoles} from './user-roles.model';
import {Users} from './users.model';

@model({
  settings: {
    postgresql: {
      table: 'roles',
      schema: 'public',
    },
    indexes: {
      uniqueValue: {
        keys: {value: 1},
        options: {unique: true},
      },
    },
  },
})
export class Roles extends Entity {
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
  })
  label: string;

  @property({
    type: 'string',
    required: true,
  })
  value: string;

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

  @hasMany(() => Permissions, {through: {model: () => RolePermissions}})
  permissions: Permissions[];

  @hasMany(() => Users, {through: {model: () => UserRoles}})
  users: Users[];

  constructor(data?: Partial<Roles>) {
    super(data);
  }
}

export interface RolesRelations { }

export type RolesWithRelations = Roles & RolesRelations;
