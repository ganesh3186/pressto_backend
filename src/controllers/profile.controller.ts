import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {
  get,
  HttpErrors,
  patch,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {EmployeeRepository, UsersRepository} from '../repositories';
import {MediaService} from '../services/media.service';

export class ProfileController {
  constructor(
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(EmployeeRepository)
    private employeeRepository: EmployeeRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.media.service')
    private mediaService: MediaService,
  ) {}

  // ─── Super Admin Profile ────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['profile:read']})
  @get('/profile/admin')
  @response(200, {description: 'Super admin profile'})
  async getAdminProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const user = await this.usersRepository.findById(currentUser[securityId], {
      include: [
        {relation: 'roles'},
        {relation: 'media', scope: {fields: {id: true, fileOriginalName: true, fileUrl: true, fileType: true}}},
      ],
    });
    const {password, resetPasswordOtp, resetPasswordOtpExpires, ...safe} = user.toJSON() as any;
    return safe;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['profile:update']})
  @patch('/profile/admin')
  @response(204, {description: 'Super admin profile updated'})
  async updateAdminProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              fullName: {type: 'string'},
              email: {type: 'string', format: 'email'},
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              mediaId: {type: 'string', format: 'uuid'},
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
      mediaId?: string;
    },
  ): Promise<void> {
    const userId = currentUser[securityId];
    const oldUser = await this.usersRepository.findById(userId);

    await this.usersRepository.updateById(userId, body);

    if (body.mediaId && oldUser.mediaId !== body.mediaId) {
      if (oldUser.mediaId) {
        await this.mediaService.updateMediaUsedStatus([oldUser.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([body.mediaId], true);
    }
  }

  // ─── Employee Profile ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/employee')
  @response(200, {description: 'Employee profile'})
  async getEmployeeProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const userId = currentUser[securityId];

    const employee = await this.employeeRepository.findOne({
      where: {userId, isDeleted: false},
      include: [
        {
          relation: 'user',
          scope: {
            fields: {id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true},
            include: [{relation: 'roles'}],
          },
        },
        {relation: 'media', scope: {fields: {id: true, fileOriginalName: true, fileUrl: true, fileType: true}}},
      ],
    });

    if (!employee) {
      throw new HttpErrors.NotFound('Employee profile not found for this user.');
    }

    return employee;
  }

  @authenticate('jwt')
  @patch('/profile/employee')
  @response(204, {description: 'Employee profile updated'})
  async updateEmployeeProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // user fields
              email: {type: 'string', format: 'email'},
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              // employee fields
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              dateOfBirth: {type: 'string', format: 'date'},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              pincode: {type: 'string'},
              mediaId: {type: 'string', format: 'uuid'},
            },
          },
        },
      },
    })
    body: {
      email?: string;
      countryCode?: string;
      phone?: string;
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      pincode?: string;
      mediaId?: string;
    },
  ): Promise<void> {
    const userId = currentUser[securityId];

    const employee = await this.employeeRepository.findOne({
      where: {userId, isDeleted: false},
    });
    if (!employee) {
      throw new HttpErrors.NotFound('Employee profile not found for this user.');
    }

    const {email, countryCode, phone, firstName, lastName, dateOfBirth, mediaId, ...addressFields} = body;

    const userFields: Record<string, unknown> = {};
    if (email !== undefined) userFields.email = email;
    if (countryCode !== undefined) userFields.countryCode = countryCode;
    if (phone !== undefined) userFields.phone = phone;
    if (firstName !== undefined || lastName !== undefined) {
      const newFirst = firstName ?? employee.firstName;
      const newLast = lastName ?? employee.lastName;
      userFields.fullName = `${newFirst} ${newLast}`;
    }

    const employeeFields: Record<string, unknown> = {...addressFields};
    if (firstName !== undefined) employeeFields.firstName = firstName;
    if (lastName !== undefined) employeeFields.lastName = lastName;
    if (dateOfBirth !== undefined) employeeFields.dateOfBirth = new Date(dateOfBirth);
    if (mediaId !== undefined) employeeFields.mediaId = mediaId;

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      if (Object.keys(userFields).length > 0) {
        await this.usersRepository.updateById(userId, userFields, {transaction: tx});
      }
      if (Object.keys(employeeFields).length > 0) {
        await this.employeeRepository.updateById(employee.id, employeeFields, {transaction: tx});
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    if (mediaId !== undefined && employee.mediaId !== mediaId) {
      if (employee.mediaId) {
        await this.mediaService.updateMediaUsedStatus([employee.mediaId], false);
      }
      await this.mediaService.updateMediaUsedStatus([mediaId], true);
    }
  }
}
