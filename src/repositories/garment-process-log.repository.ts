import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {GarmentProcessLog, GarmentProcessLogRelations} from '../models/garment-process-log.model';

export class GarmentProcessLogRepository extends DefaultCrudRepository<
  GarmentProcessLog,
  typeof GarmentProcessLog.prototype.id,
  GarmentProcessLogRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentProcessLog, dataSource);
  }
}
