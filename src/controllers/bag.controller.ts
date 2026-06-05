import { authenticate } from '@loopback/authentication';
import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { Bag } from '../models/bag.model';
import { BagRepository } from '../repositories/bag.repository';

export class BagController {
  constructor(
    @repository(BagRepository)
    public bagRepository: BagRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/bags')
  @response(200, {
    description: 'Bag model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Bag) } },
  })
  async create(): Promise<Bag> {
    const lastBag = await this.bagRepository.findOne({
      order: ['bagNumber DESC'],
    });
    const bagNumber = lastBag ? lastBag.bagNumber + 1 : 1;
    return this.bagRepository.create({ bagNumber });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/bags/count')
  @response(200, {
    description: 'Bag model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Bag) where?: Where<Bag>): Promise<Count> {
    return this.bagRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/bags')
  @response(200, {
    description: 'Array of Bag model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Bag, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Bag) filter?: Filter<Bag>): Promise<Bag[]> {
    return this.bagRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/bags/{id}')
  @response(200, {
    description: 'Bag model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Bag, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Bag, { exclude: 'where' }) filter?: FilterExcludingWhere<Bag>,
  ): Promise<Bag> {
    return this.bagRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/bags/{id}')
  @response(204, { description: 'Bag PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bag, { partial: true }),
        },
      },
    })
    bag: Partial<Bag>,
  ): Promise<void> {
    await this.bagRepository.updateById(id, bag);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @del('/bags/{id}')
  @response(204, { description: 'Bag DELETE success' })
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.bagRepository.updateById(id, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date() as any,
    } as any);
  }
}
