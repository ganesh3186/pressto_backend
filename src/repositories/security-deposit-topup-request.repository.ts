import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {SecurityDepositTopupRequest, SecurityDepositTopupRequestRelations} from '../models/security-deposit-topup-request.model';

export class SecurityDepositTopupRequestRepository extends DefaultCrudRepository<
  SecurityDepositTopupRequest,
  typeof SecurityDepositTopupRequest.prototype.id,
  SecurityDepositTopupRequestRelations
> {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(SecurityDepositTopupRequest, dataSource);
  }
}
