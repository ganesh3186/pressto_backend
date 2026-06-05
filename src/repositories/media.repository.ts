import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import { PresstoDataSource } from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Media, MediaRelations} from '../models';

export class MediaRepository extends TimeStampRepositoryMixin<
  Media,
  typeof Media.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Media,
      typeof Media.prototype.id,
      MediaRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(Media, dataSource);
  }
}
