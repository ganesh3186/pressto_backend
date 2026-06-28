import {authenticate} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, FilterExcludingWhere, IsolationLevel, repository} from '@loopback/repository';
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
import {PresstoDataSource} from '../datasources';
import {Employee} from '../models';
import {
  EmployeeRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
} from '../repositories';
import {BcryptHasher} from '../services/hash.password.bcrypt';
import {MediaService} from '../services/media.service';

export class EmployeeController {
  constructor(
    @repository(EmployeeRepository)
    public employeeRepository: EmployeeRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) {}

  private async generateUniqueUsername(email: string): Promise<string> {
    const base = email.split('@')[0].toLowerCase();
    let username = base;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await this.usersRepository.findOne({where: {username}});
      if (!existing) return username;
      username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    throw new HttpErrors.InternalServerError('Could not generate a unique username');
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/employees')
  @response(200, {description: 'Employee created'})
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: [
              'email', 'countryCode', 'phone', 'password',
              'roleValues', 'firstName', 'lastName',
              'addressLine1', 'city', 'state', 'pincode',
            ],
            properties: {
              // user fields
              email: {type: 'string', format: 'email'},
              countryCode: {type: 'string', default: '+91'},
              phone: {type: 'string'},
              password: {type: 'string', minLength: 6},
              roleValues: {type: 'array', items: {type: 'string'}},
              // employee fields
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              dateOfBirth: {type: 'string', format: 'date'},
              joiningDate: {type: 'string', format: 'date'},
              // designation: {type: 'string'},
              // department: {type: 'string'},
              mediaId: {type: 'string', format: 'uuid'},
              reportingManagerId: {type: 'string', format: 'uuid'},
              storeId: {type: 'string', format: 'uuid'},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              pincode: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      email: string;
      countryCode: string;
      phone: string;
      password: string;
      roleValues: string[];
      firstName: string;
      lastName: string;
      dateOfBirth?: string;
      joiningDate?: string;
      mediaId?: string;
      reportingManagerId?: string;
      storeId?: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      state: string;
      pincode: string;
    },
  ): Promise<object> {
    // Pre-transaction validations
    const existingUser = await this.usersRepository.findOne({
      where: {or: [{email: body.email}, {phone: body.phone}]},
    });
    if (existingUser) {
      throw new HttpErrors.BadRequest('Email or phone already in use.');
    }

    const roles = await Promise.all(
      body.roleValues.map(async v => {
        const role = await this.rolesRepository.findOne({where: {value: v}});
        if (!role) throw new HttpErrors.BadRequest(`Role not found: ${v}`);
        return role;
      }),
    );

    const existingCodes = await this.employeeRepository.find({fields: {employeeCode: true}});
    let maxNum = 0;
    for (const e of existingCodes) {
      const match = e.employeeCode?.match(/^EMP(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    const employeeCode = `EMP${String(maxNum + 1).padStart(3, '0')}`;

    const hashedPassword = await this.hasher.hashPassword(body.password);
    const username = await this.generateUniqueUsername(body.email);

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const user = await this.usersRepository.create(
        {
          fullName: `${body.firstName} ${body.lastName}`,
          username,
          email: body.email,
          countryCode: body.countryCode || '+91',
          phone: body.phone,
          password: hashedPassword,
          isActive: true,
        },
        {transaction: tx},
      );

      const employee = await this.employeeRepository.create(
        {
          userId: user.id,
          employeeCode,
          firstName: body.firstName,
          lastName: body.lastName,
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
          joiningDate: body.joiningDate ? new Date(body.joiningDate) : undefined,
          mediaId: body.mediaId,
          reportingManagerId: body.reportingManagerId,
          storeId: body.storeId,
          addressLine1: body.addressLine1,
          addressLine2: body.addressLine2,
          city: body.city,
          state: body.state,
          pincode: body.pincode,
        },
        {transaction: tx},
      );

      for (const role of roles) {
        await this.userRolesRepository.create(
          {usersId: user.id, rolesId: role.id},
          {transaction: tx},
        );
      }

      await tx.commit();

      if (employee.mediaId) {
        await this.mediaService.updateMediaUsedStatus([employee.mediaId], true);
      }

      return {
        message: 'Employee created successfully',
        employee: {...employee, user: {...user, password: undefined}},
        assignedRoles: body.roleValues,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/employees')
  @response(200, {
    description: 'Array of Employee model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Employee, {includeRelations: true}),
        },
      },
    },
  })
  async find(@param.filter(Employee) filter?: Filter<Employee>): Promise<Employee[]> {
    return this.employeeRepository.find({
      ...filter,
      include: [
        {
          relation: 'user',
          scope: {
            fields: {id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true},
            include: [{relation: 'roles'}],
          },
        },
        {relation: 'media', scope: {fields: {id: true, fileOriginalName: true, fileUrl: true, fileType: true}}},
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/employees/{id}')
  @response(200, {
    description: 'Employee model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Employee, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Employee, {exclude: 'where'}) filter?: FilterExcludingWhere<Employee>,
  ): Promise<Employee> {
    return this.employeeRepository.findById(id, {
      ...filter,
      include: [
        {
          relation: 'user',
          scope: {
            fields: {id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true},
            include: [{relation: 'roles'}],
          },
        },
        {relation: 'media', scope: {fields: {id: true, fileOriginalName: true, fileUrl: true, fileType: true}}},
        {relation: 'store', scope: {fields: {id: true, name: true, code: true}}},
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @patch('/employees/{id}')
  @response(200, {description: 'Employee updated'})
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // user fields
              fullName: {type: 'string'},
              email: {type: 'string', format: 'email'},
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              isActive: {type: 'boolean'},
              // employee fields
              employeeCode: {type: 'string'},
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              dateOfBirth: {type: 'string', format: 'date'},
              joiningDate: {type: 'string', format: 'date'},
              // designation: {type: 'string'},
              // department: {type: 'string'},
              mediaId: {type: 'string', format: 'uuid'},
              reportingManagerId: {type: 'string', format: 'uuid'},
              storeId: {type: 'string', format: 'uuid'},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              pincode: {type: 'string'},
              // role management
              roleValues: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {
      fullName?: string;
      email?: string;
      countryCode?: string;
      phone?: string;
      isActive?: boolean;
      employeeCode?: string;
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
      joiningDate?: string;
      // designation?: string;
      // department?: string;
      mediaId?: string;
      reportingManagerId?: string;
      storeId?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      pincode?: string;
      roleValues?: string[];
    },
  ): Promise<void> {
    const employee = await this.employeeRepository.findById(id);

    const {roleValues, ...rest} = body;

    const userFields: Record<string, unknown> = {};
    const employeeFields: Record<string, unknown> = {};

    const userKeys = ['fullName', 'email', 'countryCode', 'phone', 'isActive'];
    const employeeKeys = [
      'employeeCode', 'firstName', 'lastName',
      'mediaId', 'reportingManagerId', 'storeId',
      'addressLine1', 'addressLine2', 'city', 'state', 'pincode',
    ];

    for (const [key, value] of Object.entries(rest)) {
      if (userKeys.includes(key)) userFields[key] = value;
      else if (employeeKeys.includes(key)) employeeFields[key] = value;
    }

    if (rest.dateOfBirth) employeeFields.dateOfBirth = new Date(rest.dateOfBirth);
    if (rest.joiningDate) employeeFields.joiningDate = new Date(rest.joiningDate);

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      if (Object.keys(userFields).length > 0) {
        await this.usersRepository.updateById(employee.userId, userFields, {transaction: tx});
      }

      if (Object.keys(employeeFields).length > 0) {
        await this.employeeRepository.updateById(id, employeeFields, {transaction: tx});
      }

      if (roleValues?.length) {
        const roles = await Promise.all(
          roleValues.map(async v => {
            const role = await this.rolesRepository.findOne({where: {value: v}});
            if (!role) throw new HttpErrors.BadRequest(`Role not found: ${v}`);
            return role;
          }),
        );
        await this.userRolesRepository.deleteAll(
          {usersId: employee.userId},
          {transaction: tx},
        );
        for (const role of roles) {
          await this.userRolesRepository.create(
            {usersId: employee.userId, rolesId: role.id},
            {transaction: tx},
          );
        }
      }

      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    if (employeeFields.mediaId && employee.mediaId !== employeeFields.mediaId) {
      if (employee.mediaId) {
        await this.mediaService.updateMediaUsedStatus([employee.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([employeeFields.mediaId as string], true);
    }
  }
}
