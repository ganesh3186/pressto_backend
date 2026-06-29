import {Constructor, inject} from '@loopback/core';
import {DefaultCrudRepository} from '@loopback/repository';
import {
  WalletConfiguration,
  WalletConfigurationRelations,
} from '../models/wallet-configuration.model';
import {PresstoDataSource} from '../datasources';
import {TimeStampRepositoryMixin} from '../mixins/timestamp-repository-mixin';

export class WalletConfigurationRepository extends TimeStampRepositoryMixin<
  WalletConfiguration,
  typeof WalletConfiguration.prototype.id,
  Constructor<
    DefaultCrudRepository<
      WalletConfiguration,
      typeof WalletConfiguration.prototype.id,
      WalletConfigurationRelations
    >
  >
>(DefaultCrudRepository) {
  constructor(
    @inject('datasources.pressto') dataSource: PresstoDataSource,
  ) {
    super(WalletConfiguration, dataSource);
  }
}
