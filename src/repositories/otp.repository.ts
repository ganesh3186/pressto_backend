import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import { presstoDataSource } from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';
import {Otp, OtpRelations} from '../models';

export class OtpRepository extends TimeStampRepositoryMixin<
  Otp,
  typeof Otp.prototype.id,
  Constructor<
    DefaultCrudRepository<
      Otp,
      typeof Otp.prototype.id,
      OtpRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: presstoDataSource,
  ) {
    super(Otp, dataSource);
  }
}
