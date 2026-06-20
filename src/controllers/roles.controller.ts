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
import {PermissionsRepository, RolePermissionsRepository, RolesRepository} from '../repositories';

export class RolesController {
  constructor(
    @repository(RolesRepository)
    public rolesRepository: RolesRepository,
    @repository(PermissionsRepository)
    private permissionsRepository: PermissionsRepository,
    @repository(RolePermissionsRepository)
    private rolePermissionsRepository: RolePermissionsRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/roles')
  @response(200, {description: 'Role created'})
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['label', 'value'],
            properties: {
              label: {type: 'string'},
              value: {type: 'string'},
              description: {type: 'string'},
              loginAccess: {type: 'boolean'},
              permissionValues: {
                type: 'array',
                items: {type: 'string'},
                description: 'Permission codes to assign to this role',
              },
            },
          },
        },
      },
    })
    body: {
      label: string;
      value: string;
      description?: string;
      loginAccess?: boolean;
      permissionValues?: string[];
    },
  ): Promise<object> {
    const {permissionValues, ...roleFields} = body;

    const created = await this.rolesRepository.create(roleFields);

    if (permissionValues?.length) {
      for (const permValue of permissionValues) {
        const permission = await this.permissionsRepository.findOne({
          where: {permission: permValue},
        });
        if (!permission) throw new HttpErrors.BadRequest(`Permission not found: ${permValue}`);
        await this.rolePermissionsRepository.create({
          rolesId: created.id,
          permissionsId: permission.id,
        });
      }
    }

    return {
      message: 'Role created successfully',
      role: created,
      assignedPermissions: permissionValues ?? [],
    };
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
  @response(200, {description: 'Role updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              label: {type: 'string'},
              value: {type: 'string'},
              description: {type: 'string'},
              isActive: {type: 'boolean'},
              loginAccess: {type: 'boolean'},
              addPermissionValues: {
                type: 'array',
                items: {type: 'string'},
                description: 'Permission codes to add to this role',
              },
              removePermissionValues: {
                type: 'array',
                items: {type: 'string'},
                description: 'Permission codes to remove from this role',
              },
            },
          },
        },
      },
    })
    body: {
      label?: string;
      value?: string;
      description?: string;
      isActive?: boolean;
      loginAccess?: boolean;
      addPermissionValues?: string[];
      removePermissionValues?: string[];
    },
  ): Promise<void> {
    const existing = await this.rolesRepository.findById(id);
    if (existing.isLocked) {
      throw new HttpErrors.Forbidden('This role is locked and cannot be modified.');
    }

    const {addPermissionValues, removePermissionValues, ...fields} = body;

    if (Object.keys(fields).length > 0) {
      await this.rolesRepository.updateById(id, fields);
    }

    if (addPermissionValues?.length) {
      for (const permValue of addPermissionValues) {
        const permission = await this.permissionsRepository.findOne({
          where: {permission: permValue},
        });
        if (!permission) throw new HttpErrors.BadRequest(`Permission not found: ${permValue}`);
        const exists = await this.rolePermissionsRepository.findOne({
          where: {rolesId: id, permissionsId: permission.id},
        });
        if (!exists) {
          await this.rolePermissionsRepository.create({
            rolesId: id,
            permissionsId: permission.id,
          });
        }
      }
    }

    if (removePermissionValues?.length) {
      for (const permValue of removePermissionValues) {
        const permission = await this.permissionsRepository.findOne({
          where: {permission: permValue},
        });
        if (!permission) throw new HttpErrors.BadRequest(`Permission not found: ${permValue}`);
        await this.rolePermissionsRepository.deleteAll({
          rolesId: id,
          permissionsId: permission.id,
        });
      }
    }
  }
}
