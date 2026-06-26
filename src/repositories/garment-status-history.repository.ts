import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {GarmentStatusHistory, GarmentStatusHistoryRelations} from '../models/garment-status-history.model';

export class GarmentStatusHistoryRepository extends DefaultCrudRepository<
  GarmentStatusHistory,
  typeof GarmentStatusHistory.prototype.id,
  GarmentStatusHistoryRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(GarmentStatusHistory, dataSource);
  }
}
