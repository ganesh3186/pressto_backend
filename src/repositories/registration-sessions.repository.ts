import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import { presstoDataSource } from '../datasources';
import {RegistrationSessions, RegistrationSessionsRelations} from '../models';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class RegistrationSessionsRepository extends TimeStampRepositoryMixin<
  RegistrationSessions,
  typeof RegistrationSessions.prototype.id,
  Constructor<
    DefaultCrudRepository<
      RegistrationSessions,
      typeof RegistrationSessions.prototype.id,
      RegistrationSessionsRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: presstoDataSource,
  ) {
    super(RegistrationSessions, dataSource);
  }
}
