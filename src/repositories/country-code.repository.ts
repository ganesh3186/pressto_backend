import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {CountryCode, CountryCodeRelations} from '../models';

export class CountryCodeRepository extends TimeStampRepositoryMixin<
  CountryCode,
  typeof CountryCode.prototype.id,
  Constructor<DefaultCrudRepository<CountryCode, typeof CountryCode.prototype.id, CountryCodeRelations>>
>(DefaultCrudRepository) {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(CountryCode, dataSource);
  }
}
