import {authenticate} from '@loopback/authentication';
import {
  repository,
} from '@loopback/repository';
import {
  HttpErrors,
  post,
  requestBody,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {PermissionsRepository, RolePermissionsRepository, RolesRepository} from '../repositories';

export class PermissionsController {
  constructor(
    @repository(PermissionsRepository)
    public permissionsRepository: PermissionsRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(RolePermissionsRepository)
    private rolePermissionsRepository: RolePermissionsRepository
  ) { }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/permissions')
  async createPermission(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['permission', 'roleValues'],
            properties: {
              permission: {type: 'string'},
              description: {type: 'string'},
              roleValues: {
                type: 'array',
                items: {type: 'string'}
              }
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
      throw new HttpErrors.BadRequest('Permission already exists');
    }

    const created = await this.permissionsRepository.create({
      permission: body.permission,
      description: body.description ?? '',
    });

    for (const roleValue of body.roleValues) {
      const role = await this.rolesRepository.findOne({
        where: {value: roleValue},
      });

      if (!role) {
        throw new HttpErrors.BadRequest(`Role not found: ${roleValue}`);
      }

      await this.rolePermissionsRepository.create({
        rolesId: role.id,
        permissionsId: created.id,
      });
    }

    return {
      message: 'Permission created & assigned successfully',
      permission: created,
      assignedToRoles: body.roleValues,
    };
  }

  // @get('/permissions/count')
  // @response(200, {
  //   description: 'Permissions model count',
  //   content: {'application/json': {schema: CountSchema}},
  // })
  // async count(
  //   @param.where(Permissions) where?: Where<Permissions>,
  // ): Promise<Count> {
  //   return this.permissionsRepository.count(where);
  // }

  // @get('/permissions')
  // @response(200, {
  //   description: 'Array of Permissions model instances',
  //   content: {
  //     'application/json': {
  //       schema: {
  //         type: 'array',
  //         items: getModelSchemaRef(Permissions, {includeRelations: true}),
  //       },
  //     },
  //   },
  // })
  // async find(
  //   @param.filter(Permissions) filter?: Filter<Permissions>,
  // ): Promise<Permissions[]> {
  //   return this.permissionsRepository.find(filter);
  // }

  // @patch('/permissions')
  // @response(200, {
  //   description: 'Permissions PATCH success count',
  //   content: {'application/json': {schema: CountSchema}},
  // })
  // async updateAll(
  //   @requestBody({
  //     content: {
  //       'application/json': {
  //         schema: getModelSchemaRef(Permissions, {partial: true}),
  //       },
  //     },
  //   })
  //   permissions: Permissions,
  //   @param.where(Permissions) where?: Where<Permissions>,
  // ): Promise<Count> {
  //   return this.permissionsRepository.updateAll(permissions, where);
  // }

  // @get('/permissions/{id}')
  // @response(200, {
  //   description: 'Permissions model instance',
  //   content: {
  //     'application/json': {
  //       schema: getModelSchemaRef(Permissions, {includeRelations: true}),
  //     },
  //   },
  // })
  // async findById(
  //   @param.path.string('id') id: string,
  //   @param.filter(Permissions, {exclude: 'where'}) filter?: FilterExcludingWhere<Permissions>
  // ): Promise<Permissions> {
  //   return this.permissionsRepository.findById(id, filter);
  // }

  // @patch('/permissions/{id}')
  // @response(204, {
  //   description: 'Permissions PATCH success',
  // })
  // async updateById(
  //   @param.path.string('id') id: string,
  //   @requestBody({
  //     content: {
  //       'application/json': {
  //         schema: getModelSchemaRef(Permissions, {partial: true}),
  //       },
  //     },
  //   })
  //   permissions: Permissions,
  // ): Promise<void> {
  //   await this.permissionsRepository.updateById(id, permissions);
  // }

  // @put('/permissions/{id}')
  // @response(204, {
  //   description: 'Permissions PUT success',
  // })
  // async replaceById(
  //   @param.path.string('id') id: string,
  //   @requestBody() permissions: Permissions,
  // ): Promise<void> {
  //   await this.permissionsRepository.replaceById(id, permissions);
  // }

  // @del('/permissions/{id}')
  // @response(204, {
  //   description: 'Permissions DELETE success',
  // })
  // async deleteById(@param.path.string('id') id: string): Promise<void> {
  //   await this.permissionsRepository.deleteById(id);
  // }
}
