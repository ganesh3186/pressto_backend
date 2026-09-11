import {authenticate} from '@loopback/authentication';
import {Filter, repository} from '@loopback/repository';
import {get, getModelSchemaRef, param, response} from '@loopback/rest';
import {CountryCode} from '../models';
import {CountryCodeRepository} from '../repositories';

export class CountryCodeController {
  constructor(
    @repository(CountryCodeRepository)
    public countryCodeRepository: CountryCodeRepository,
  ) {}

  @authenticate('jwt')
  @get('/country-codes')
  @response(200, {
    description: 'Active country dialing codes for phone number selectors',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(CountryCode)}}},
  })
  async find(@param.filter(CountryCode) filter?: Filter<CountryCode>): Promise<CountryCode[]> {
    return this.countryCodeRepository.find({
      ...filter,
      where: {and: [{isActive: true}, {isDeleted: false}, filter?.where ?? {}]},
      order: filter?.order ?? ['displayOrder ASC', 'countryName ASC'],
    });
  }
}
