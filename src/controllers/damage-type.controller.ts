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
import { DamageType } from '../models/damage-type.model';
import { DamageTypeRepository } from '../repositories/damage-type.repository';

export class DamageTypeController {
  constructor(
    @repository(DamageTypeRepository)
    public damageTypeRepository: DamageTypeRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/damage-types')
  @response(200, {
    description: 'DamageType model instance',
    content: { 'application/json': { schema: getModelSchemaRef(DamageType) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(DamageType, {
            title: 'NewDamageType',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    damageType: Omit<DamageType, 'id'>,
  ): Promise<DamageType> {
    return this.damageTypeRepository.create(damageType);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/damage-types/count')
  @response(200, {
    description: 'DamageType model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(
    @param.where(DamageType) where?: Where<DamageType>,
  ): Promise<Count> {
    return this.damageTypeRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/damage-types')
  @response(200, {
    description: 'Array of DamageType model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(DamageType, { includeRelations: true }),
        },
      },
    },
  })
  async find(
    @param.filter(DamageType) filter?: Filter<DamageType>,
  ): Promise<DamageType[]> {
    return this.damageTypeRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/damage-types')
  @response(200, {
    description: 'DamageType PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(DamageType, { partial: true }),
        },
      },
    })
    damageType: DamageType,
    @param.where(DamageType) where?: Where<DamageType>,
  ): Promise<Count> {
    return this.damageTypeRepository.updateAll(damageType, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/damage-types/{id}')
  @response(200, {
    description: 'DamageType model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(DamageType, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(DamageType, { exclude: 'where' })
    filter?: FilterExcludingWhere<DamageType>,
  ): Promise<DamageType> {
    return this.damageTypeRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/damage-types/{id}')
  @response(204, { description: 'DamageType PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(DamageType, { partial: true }),
        },
      },
    })
    damageType: DamageType,
  ): Promise<void> {
    await this.damageTypeRepository.updateById(id, damageType);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/damage-types/{id}')
  // @response(204, {description: 'DamageType PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() damageType: DamageType,
  // ): Promise<void> {
  //   await this.damageTypeRepository.replaceById(id, damageType);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/damage-types/{id}')
  // @response(204, {description: 'DamageType DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.damageTypeRepository.deleteById(id);
  // }
}
