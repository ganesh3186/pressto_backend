import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {PickupChangeRequest, PickupChangeRequestRelations} from '../models/pickup-change-request.model';

export class PickupChangeRequestRepository extends DefaultCrudRepository<
  PickupChangeRequest,
  typeof PickupChangeRequest.prototype.id,
  PickupChangeRequestRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(PickupChangeRequest, dataSource);
  }
}
