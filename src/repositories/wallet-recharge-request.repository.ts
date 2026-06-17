import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {WalletRechargeRequest, WalletRechargeRequestRelations} from '../models/wallet-recharge-request.model';

export class WalletRechargeRequestRepository extends DefaultCrudRepository<
  WalletRechargeRequest,
  typeof WalletRechargeRequest.prototype.id,
  WalletRechargeRequestRelations
> {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(WalletRechargeRequest, dataSource);
  }
}
