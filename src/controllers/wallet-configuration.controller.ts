import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {
  get,
  getModelSchemaRef,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {HttpErrors} from '@loopback/rest';
import {authorize} from '../authorization';
import {WalletConfiguration} from '../models/wallet-configuration.model';
import {WalletConfigurationRepository} from '../repositories/wallet-configuration.repository';

export class WalletConfigurationController {
  constructor(
    @repository(WalletConfigurationRepository)
    public walletConfigurationRepository: WalletConfigurationRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/wallet-configuration')
  @response(200, {
    description: 'WalletConfiguration model instance',
    content: {'application/json': {schema: getModelSchemaRef(WalletConfiguration)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(WalletConfiguration, {
            title: 'NewWalletConfiguration',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    walletConfiguration: Omit<WalletConfiguration, 'id'>,
  ): Promise<WalletConfiguration> {
    const existing = await this.walletConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (existing) {
      throw new HttpErrors.Conflict(
        'Wallet configuration already exists. Use PATCH to update it.',
      );
    }
    return this.walletConfigurationRepository.create(walletConfiguration);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/wallet-configuration')
  @response(200, {
    description: 'WalletConfiguration singleton',
    content: {'application/json': {schema: getModelSchemaRef(WalletConfiguration)}},
  })
  async find(): Promise<WalletConfiguration | null> {
    return this.walletConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/wallet-configuration')
  @response(204, {description: 'WalletConfiguration PATCH success'})
  async update(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(WalletConfiguration, {partial: true}),
        },
      },
    })
    walletConfiguration: Partial<WalletConfiguration>,
  ): Promise<void> {
    const existing = await this.walletConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!existing) {
      throw new HttpErrors.NotFound('Wallet configuration has not been set up yet.');
    }
    await this.walletConfigurationRepository.updateById(existing.id, walletConfiguration);
  }
}
