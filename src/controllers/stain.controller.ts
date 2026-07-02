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
  put,
  requestBody,
  response,
} from '@loopback/rest';
import { authorize } from '../authorization';
import { Stain } from '../models/stain.model';
import { StainRepository } from '../repositories/stain.repository';

export class StainController {
  constructor(
    @repository(StainRepository)
    public stainRepository: StainRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/stains')
  @response(200, {
    description: 'Stain model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Stain) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Stain, {
            title: 'NewStain',
            exclude: ['id', 'code', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    stain: Omit<Stain, 'id'>,
  ): Promise<Stain> {
    const existing = await this.stainRepository.find({ fields: { code: true } });
    let maxNum = 0;
    for (const s of existing) {
      const match = s.code?.match(/^STN(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    stain.code = `STN${String(maxNum + 1).padStart(3, '0')}`;
    return this.stainRepository.create(stain);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/stains/count')
  @response(200, {
    description: 'Stain model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Stain) where?: Where<Stain>): Promise<Count> {
    return this.stainRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/stains')
  @response(200, {
    description: 'Array of Stain model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Stain, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Stain) filter?: Filter<Stain>): Promise<Stain[]> {
    return this.stainRepository.find({...filter, where: {and: [{isDeleted: false}, filter?.where ?? {}]}, order: ['createdAt DESC']});
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/stains')
  @response(200, {
    description: 'Stain PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Stain, { partial: true }),
        },
      },
    })
    stain: Stain,
    @param.where(Stain) where?: Where<Stain>,
  ): Promise<Count> {
    return this.stainRepository.updateAll(stain, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/stains/{id}')
  @response(200, {
    description: 'Stain model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Stain, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Stain, { exclude: 'where' })
    filter?: FilterExcludingWhere<Stain>,
  ): Promise<Stain> {
    return this.stainRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/stains/{id}')
  @response(204, { description: 'Stain PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': { schema: getModelSchemaRef(Stain, { partial: true }) },
      },
    })
    stain: Stain,
  ): Promise<void> {
    await this.stainRepository.updateById(id, stain);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/stains/{id}')
  // @response(204, {description: 'Stain PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() stain: Stain,
  // ): Promise<void> {
  //   await this.stainRepository.replaceById(id, stain);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/stains/{id}')
  // @response(204, {description: 'Stain DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.stainRepository.deleteById(id);
  // }
}
