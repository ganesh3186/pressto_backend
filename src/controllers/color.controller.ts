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
import { Color } from '../models/color.model';
import { ColorRepository } from '../repositories/color.repository';

export class ColorController {
  constructor(
    @repository(ColorRepository)
    public colorRepository: ColorRepository,
  ) { }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @post('/colors')
  @response(200, {
    description: 'Color model instance',
    content: { 'application/json': { schema: getModelSchemaRef(Color) } },
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Color, {
            title: 'NewColor',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    color: Omit<Color, 'id'>,
  ): Promise<Color> {
    return this.colorRepository.create(color);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/colors/count')
  @response(200, {
    description: 'Color model count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async count(@param.where(Color) where?: Where<Color>): Promise<Count> {
    return this.colorRepository.count(where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/colors')
  @response(200, {
    description: 'Array of Color model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Color, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Color) filter?: Filter<Color>): Promise<Color[]> {
    return this.colorRepository.find(filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/colors')
  @response(200, {
    description: 'Color PATCH success count',
    content: { 'application/json': { schema: CountSchema } },
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Color, { partial: true }),
        },
      },
    })
    color: Color,
    @param.where(Color) where?: Where<Color>,
  ): Promise<Count> {
    return this.colorRepository.updateAll(color, where);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @get('/colors/{id}')
  @response(200, {
    description: 'Color model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Color, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Color, { exclude: 'where' })
    filter?: FilterExcludingWhere<Color>,
  ): Promise<Color> {
    return this.colorRepository.findById(id, filter);
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
  @patch('/colors/{id}')
  @response(204, { description: 'Color PATCH success' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': { schema: getModelSchemaRef(Color, { partial: true }) },
      },
    })
    color: Color,
  ): Promise<void> {
    await this.colorRepository.updateById(id, color);
  }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @put('/colors/{id}')
  // @response(204, {description: 'Color PUT success'})
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() color: Color,
  // ): Promise<void> {
  //   await this.colorRepository.replaceById(id, color);
  // }

  // @authenticate('jwt')
  // @authorize({roles: ['super_admin']})
  // @del('/colors/{id}')
  // @response(204, {description: 'Color DELETE success'})
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.colorRepository.deleteById(id);
  // }
}
