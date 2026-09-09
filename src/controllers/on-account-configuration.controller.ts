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
import {OnAccountConfiguration} from '../models/on-account-configuration.model';
import {OnAccountConfigurationRepository} from '../repositories/on-account-configuration.repository';

/**
 * The global default half of the On Account "invoice span" — see
 * on-account-configuration.model.ts. Deliberately permission-gated on every
 * verb, including GET: this whole screen is meant to be restricted to
 * whoever holds on_account:configure, not just its write actions.
 */
export class OnAccountConfigurationController {
  constructor(
    @repository(OnAccountConfigurationRepository)
    public onAccountConfigurationRepository: OnAccountConfigurationRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:configure']})
  @post('/on-account-configuration')
  @response(200, {
    description: 'OnAccountConfiguration model instance',
    content: {'application/json': {schema: getModelSchemaRef(OnAccountConfiguration)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(OnAccountConfiguration, {
            title: 'NewOnAccountConfiguration',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    onAccountConfiguration: Omit<OnAccountConfiguration, 'id'>,
  ): Promise<OnAccountConfiguration> {
    const existing = await this.onAccountConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (existing) {
      throw new HttpErrors.Conflict(
        'On Account configuration already exists. Use PATCH to update it.',
      );
    }
    return this.onAccountConfigurationRepository.create(onAccountConfiguration);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:configure']})
  @get('/on-account-configuration')
  @response(200, {
    description: 'OnAccountConfiguration singleton',
    content: {'application/json': {schema: getModelSchemaRef(OnAccountConfiguration)}},
  })
  async find(): Promise<OnAccountConfiguration | null> {
    return this.onAccountConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['on_account:configure']})
  @patch('/on-account-configuration')
  @response(204, {description: 'OnAccountConfiguration PATCH success'})
  async update(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(OnAccountConfiguration, {partial: true}),
        },
      },
    })
    onAccountConfiguration: Partial<OnAccountConfiguration>,
  ): Promise<void> {
    const existing = await this.onAccountConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!existing) {
      throw new HttpErrors.NotFound('On Account configuration has not been set up yet.');
    }
    await this.onAccountConfigurationRepository.updateById(existing.id, onAccountConfiguration);
  }
}
