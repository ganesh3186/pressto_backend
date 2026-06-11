import {authenticate} from '@loopback/authentication';
import {Filter, FilterExcludingWhere, repository} from '@loopback/repository';
import {
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {Roles} from '../models';
import {RolesRepository} from '../repositories';

export class RolesController {
  constructor(
    @repository(RolesRepository)
    public rolesRepository: RolesRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/roles')
  @response(200, {
    description: 'Roles model instance',
    content: {'application/json': {schema: getModelSchemaRef(Roles)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Roles, {
            title: 'NewRole',
            exclude: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
          }),
        },
      },
    })
    roles: Omit<Roles, 'id'>,
  ): Promise<Roles> {
    return this.rolesRepository.create(roles);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/roles')
  @response(200, {
    description: 'Array of Roles model instances',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(Roles, {includeRelations: true})},
      },
    },
  })
  async find(@param.filter(Roles) filter?: Filter<Roles>): Promise<Roles[]> {
    return this.rolesRepository.find({
      ...filter,
      include: [{relation: 'permissions'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/roles/{id}')
  @response(200, {
    description: 'Roles model instance',
    content: {
      'application/json': {schema: getModelSchemaRef(Roles, {includeRelations: true})},
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Roles, {exclude: 'where'}) filter?: FilterExcludingWhere<Roles>,
  ): Promise<Roles> {
    return this.rolesRepository.findById(id, {
      ...filter,
      include: [{relation: 'permissions'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/roles/{id}')
  @response(204, {description: 'Roles PATCH success'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Roles, {partial: true}),
        },
      },
    })
    roles: Partial<Roles>,
  ): Promise<void> {
    const existing = await this.rolesRepository.findById(id);
    if (existing.isLocked) {
      throw new HttpErrors.Forbidden('This role is locked and cannot be modified.');
    }
    await this.rolesRepository.updateById(id, roles);
  }
}
