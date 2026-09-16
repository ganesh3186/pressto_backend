import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {StorePincodeCoverage, StorePincodeCoverageRelations} from '../models/store-pincode-coverage.model';

export class StorePincodeCoverageRepository extends DefaultCrudRepository<
  StorePincodeCoverage,
  typeof StorePincodeCoverage.prototype.id,
  StorePincodeCoverageRelations
> {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(StorePincodeCoverage, dataSource);
  }
}
