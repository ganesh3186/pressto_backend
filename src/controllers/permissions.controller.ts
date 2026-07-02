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
import {PermissionsRepository, RolePermissionsRepository, RolesRepository} from '../repositories';
import {Permissions} from '../models';

export class PermissionsController {
  constructor(
    @repository(PermissionsRepository)
    public permissionsRepository: PermissionsRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(RolePermissionsRepository)
    private rolePermissionsRepository: RolePermissionsRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/permissions')
  @response(200, {description: 'Permission created and assigned to roles'})
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['permission', 'roleValues'],
            properties: {
              permission: {type: 'string'},
              description: {type: 'string'},
              roleValues: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {permission: string; description?: string; roleValues: string[]},
  ) {
    const exist = await this.permissionsRepository.findOne({
      where: {permission: body.permission},
    });
    if (exist) {
      throw new HttpErrors.BadRequest('Permission already exists.');
    }

    const created = await this.permissionsRepository.create({
      permission: body.permission,
      description: body.description ?? '',
    });

    for (const roleValue of body.roleValues) {
      const role = await this.rolesRepository.findOne({where: {value: roleValue}});
      if (!role) throw new HttpErrors.BadRequest(`Role not found: ${roleValue}`);
      await this.rolePermissionsRepository.create({
        rolesId: role.id,
        permissionsId: created.id,
      });
    }

    return {
      message: 'Permission created and assigned successfully',
      permission: created,
      assignedToRoles: body.roleValues,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/permissions')
  @response(200, {
    description: 'Array of Permissions model instances',
    content: {
      'application/json': {
        schema: {type: 'array', items: getModelSchemaRef(Permissions, {includeRelations: true})},
      },
    },
  })
  async find(@param.filter(Permissions) filter?: Filter<Permissions>): Promise<Permissions[]> {
    return this.permissionsRepository.find({
      ...filter,
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
      include: [{relation: 'roles'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/permissions/{id}')
  @response(200, {
    description: 'Permissions model instance',
    content: {
      'application/json': {schema: getModelSchemaRef(Permissions, {includeRelations: true})},
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Permissions, {exclude: 'where'}) filter?: FilterExcludingWhere<Permissions>,
  ): Promise<Permissions> {
    return this.permissionsRepository.findById(id, {
      ...filter,
      include: [{relation: 'roles'}],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/permissions/{id}')
  @response(200, {description: 'Permission updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              permission: {type: 'string'},
              description: {type: 'string'},
              isActive: {type: 'boolean'},
              addRoleValues: {type: 'array', items: {type: 'string'}},
              removeRoleValues: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {
      permission?: string;
      description?: string;
      isActive?: boolean;
      addRoleValues?: string[];
      removeRoleValues?: string[];
    },
  ): Promise<void> {
    const {addRoleValues, removeRoleValues, ...fields} = body;

    if (Object.keys(fields).length > 0) {
      await this.permissionsRepository.updateById(id, fields);
    }

    if (addRoleValues?.length) {
      for (const roleValue of addRoleValues) {
        const role = await this.rolesRepository.findOne({where: {value: roleValue}});
        if (!role) throw new HttpErrors.BadRequest(`Role not found: ${roleValue}`);
        const exists = await this.rolePermissionsRepository.findOne({
          where: {rolesId: role.id, permissionsId: id},
        });
        if (!exists) {
          await this.rolePermissionsRepository.create({
            rolesId: role.id,
            permissionsId: id,
          });
        }
      }
    }

    if (removeRoleValues?.length) {
      for (const roleValue of removeRoleValues) {
        const role = await this.rolesRepository.findOne({where: {value: roleValue}});
        if (!role) throw new HttpErrors.BadRequest(`Role not found: ${roleValue}`);
        await this.rolePermissionsRepository.deleteAll({
          rolesId: role.id,
          permissionsId: id,
        });
      }
    }
  }
}
