import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {ApprovalAction, ApprovalActionRelations} from '../models/approval-action.model';

export class ApprovalActionRepository extends DefaultCrudRepository<
  ApprovalAction,
  typeof ApprovalAction.prototype.id,
  ApprovalActionRelations
> {
  constructor(@inject('datasources.pressto') dataSource: PresstoDataSource) {
    super(ApprovalAction, dataSource);
  }
}
