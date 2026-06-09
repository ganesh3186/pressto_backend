import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {
  AdditionalChargeMaster,
  AdditionalChargeMasterRelations,
} from '../models/additional-charge-master.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class AdditionalChargeMasterRepository extends TimeStampRepositoryMixin<
  AdditionalChargeMaster,
  typeof AdditionalChargeMaster.prototype.id,
  Constructor<
    DefaultCrudRepository<
      AdditionalChargeMaster,
      typeof AdditionalChargeMaster.prototype.id,
      AdditionalChargeMasterRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(AdditionalChargeMaster, dataSource);
  }
}
