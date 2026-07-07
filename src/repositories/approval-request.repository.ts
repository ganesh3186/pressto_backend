import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {ApprovalRequest, ApprovalRequestRelations} from '../models/approval-request.model';

export class ApprovalRequestRepository extends DefaultCrudRepository<
  ApprovalRequest,
  typeof ApprovalRequest.prototype.id,
  ApprovalRequestRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(ApprovalRequest, dataSource);
  }
}
