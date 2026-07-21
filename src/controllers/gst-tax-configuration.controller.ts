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
import {GstTaxConfiguration} from '../models/gst-tax-configuration.model';
import {GstTaxConfigurationRepository} from '../repositories/gst-tax-configuration.repository';

export class GstTaxConfigurationController {
  constructor(
    @repository(GstTaxConfigurationRepository)
    public gstTaxConfigurationRepository: GstTaxConfigurationRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gst_tax_configuration:create']})
  @post('/gst-tax-configuration')
  @response(200, {
    description: 'GstTaxConfiguration model instance',
    content: {'application/json': {schema: getModelSchemaRef(GstTaxConfiguration)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(GstTaxConfiguration, {
            title: 'NewGstTaxConfiguration',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    gstTaxConfiguration: Omit<GstTaxConfiguration, 'id'>,
  ): Promise<GstTaxConfiguration> {
    const existing = await this.gstTaxConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (existing) {
      throw new HttpErrors.Conflict(
        'GST Tax Configuration already exists. Use PATCH to update it.',
      );
    }
    return this.gstTaxConfigurationRepository.create(gstTaxConfiguration);
  }

  @authenticate('jwt')
  @get('/gst-tax-configuration')
  @response(200, {
    description: 'GstTaxConfiguration singleton',
    content: {'application/json': {schema: getModelSchemaRef(GstTaxConfiguration)}},
  })
  async find(): Promise<GstTaxConfiguration> {
    const config = await this.gstTaxConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!config) {
      throw new HttpErrors.NotFound('GST Tax Configuration has not been set up yet.');
    }
    return config;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gst_tax_configuration:update']})
  @patch('/gst-tax-configuration')
  @response(204, {description: 'GstTaxConfiguration PATCH success'})
  async update(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(GstTaxConfiguration, {partial: true}),
        },
      },
    })
    gstTaxConfiguration: Partial<GstTaxConfiguration>,
  ): Promise<void> {
    const existing = await this.gstTaxConfigurationRepository.findOne({
      where: {isDeleted: false},
    });
    if (!existing) {
      throw new HttpErrors.NotFound('GST Tax Configuration has not been set up yet.');
    }
    await this.gstTaxConfigurationRepository.updateById(existing.id, gstTaxConfiguration);
  }
}
