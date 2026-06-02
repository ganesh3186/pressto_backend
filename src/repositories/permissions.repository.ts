import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import { presstoDataSource } from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Permissions, PermissionsRelations} from '../models';

export class PermissionsRepository extends TimeStampRepositoryMixin<
  Permissions,
  typeof Permissions.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Permissions,
      typeof Permissions.prototype.id,
      PermissionsRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: presstoDataSource,
  ) {
    super(Permissions, dataSource);
  }
}
