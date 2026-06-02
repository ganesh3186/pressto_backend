import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import { presstoDataSource } from '../datasources';
import {RolePermissions, RolePermissionsRelations} from '../models';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class RolePermissionsRepository extends TimeStampRepositoryMixin<
  RolePermissions,
  typeof RolePermissions.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RolePermissions,
      typeof RolePermissions.prototype.id,
      RolePermissionsRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: presstoDataSource,
  ) {
    super(RolePermissions, dataSource);
  }
}
