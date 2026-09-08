import {inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {PresstoDataSource} from '../datasources';
import {GatewayPaymentLink, GatewayPaymentLinkRelations} from '../models/gateway-payment-link.model';

export class GatewayPaymentLinkRepository extends DefaultCrudRepository<
  GatewayPaymentLink,
  typeof GatewayPaymentLink.prototype.id,
  GatewayPaymentLinkRelations
> {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(GatewayPaymentLink, dataSource);
  }
}
