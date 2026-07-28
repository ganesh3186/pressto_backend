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
import {assertNoProtectedRoles, PROTECTED_ROLES} from '../utils/role-guard';

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
  @authorize({roles: ['super_admin'], permissions: ['employee:create']})
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
              linkExistingAccount: {
                type: 'boolean',
                description:
                  'Must be explicitly true to attach this employee profile to an existing ' +
                  'login found by phone/email (e.g. a customer who is now staff). Without it, ' +
                  'a match returns a 409 so the operator can confirm before accounts are linked.',
              },
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
      linkExistingAccount?: boolean;
    },
  ): Promise<object> {
    // super_admin is created exactly once, through the dedicated registration
    // endpoint. It must never be reachable from generic employee role management.
    assertNoProtectedRoles(body.roleValues);

    // Customers and employees share the users table, and login resolves a single
    // user by email. So when this phone or email already belongs to someone —
    // typically a customer who has now been hired — the employee record can be
    // attached to that existing login instead of refused. But this must be a
    // deliberate choice, not a silent side effect of a phone-number typo:
    //   - it is NEVER allowed onto the super_admin account, full stop.
    //   - for any other account, the caller must resend with
    //     linkExistingAccount: true after being shown who they'd be linking to.
    // The existing account's own identity (name/email/phone) is left untouched —
    // whatever was typed into this form for those fields is discarded once linked.
    const existingUser = await this.usersRepository.findOne({
      where: {or: [{email: body.email}, {phone: body.phone}]},
      include: [{relation: 'roles'}],
    });
    if (existingUser) {
      const existingRoleValues = (existingUser.roles ?? []).map(r => r.value);
      if (PROTECTED_ROLES.some(r => existingRoleValues.includes(r))) {
        throw new HttpErrors.Conflict(
          'That phone or email belongs to a protected system account and cannot be turned into an employee.',
        );
      }

      const alreadyEmployee = await this.employeeRepository.findOne({
        where: {userId: existingUser.id, isDeleted: false},
      });
      if (alreadyEmployee) {
        throw new HttpErrors.Conflict(
          `That phone or email already belongs to employee ${alreadyEmployee.employeeCode}.`,
        );
      }

      if (!body.linkExistingAccount) {
        throw new HttpErrors.Conflict(
          JSON.stringify({
            code: 'EXISTING_ACCOUNT_MATCH',
            message: 'That phone or email already belongs to an existing account. ' +
              'Resend with linkExistingAccount: true to attach an employee profile to it.',
            existingAccount: {
              fullName: existingUser.fullName,
              email: existingUser.email,
              phone: existingUser.phone,
              roles: existingRoleValues,
            },
          }),
        );
      }
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

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      // Reuse the existing login when this person is already in the system —
      // their password is left alone, since changing it would lock them out of
      // the account they already use.
      const user = existingUser
        ? existingUser
        : await this.usersRepository.create(
            {
              fullName: `${body.firstName} ${body.lastName}`,
              username: await this.generateUniqueUsername(body.email),
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
        // An existing login may already hold some of these — adding the same
        // role twice would leave duplicate rows behind.
        const alreadyAssigned = existingUser
          ? await this.userRolesRepository.findOne({
              where: {usersId: user.id, rolesId: role.id},
            })
          : null;
        if (alreadyAssigned) continue;

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
  @authorize({roles: ['super_admin'], permissions: ['employee:read']})
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
      where: {and: [{isDeleted: false}, filter?.where ?? {}]},
      order: ['createdAt DESC'],
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
  @authorize({roles: ['super_admin'], permissions: ['employee:read']})
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
  @authorize({roles: ['super_admin'], permissions: ['employee:update']})
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
              password: {type: 'string', minLength: 6, description: 'Resets the login password'},
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
      password?: string;
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
    // super_admin must never be grantable — or revocable — through employee
    // role management. (It's also the only thing standing between this and a
    // previously-live incident: a customer's phone number collided with the
    // super admin's, bug in create() attached an Employee row to that same
    // login, and editing that "employee"'s role here would have silently
    // deleted the real super admin's role via the deleteAll+recreate below.)
    assertNoProtectedRoles(body.roleValues);

    const employee = await this.employeeRepository.findById(id);

    const {roleValues, password, ...rest} = body;

    const userFields: Record<string, unknown> = {};
    const employeeFields: Record<string, unknown> = {};

    // A new password is hashed here — never written through as plain text.
    // Blank means "leave it alone", so the form can submit an empty field.
    if (password?.trim()) {
      userFields.password = await this.hasher.hashPassword(password.trim());
    }

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
    // isActive must be kept in sync on both tables
    if (rest.isActive !== undefined) employeeFields.isActive = rest.isActive;

    // Create() checks phone/email uniqueness up front; edits must too, or a
    // typo silently gives two different logins the same phone/email — which
    // is exactly how the earlier incident's duplicate-phone accounts happened.
    if (userFields.phone || userFields.email) {
      const orConditions: object[] = [];
      if (userFields.phone) orConditions.push({phone: userFields.phone});
      if (userFields.email) orConditions.push({email: userFields.email});
      const collision = await this.usersRepository.findOne({
        where: {and: [{or: orConditions}, {id: {neq: employee.userId}}]},
      });
      if (collision) {
        throw new HttpErrors.Conflict('That phone or email is already used by another account.');
      }
    }

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
