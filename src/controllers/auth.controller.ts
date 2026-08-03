import { authenticate, AuthenticationBindings } from '@loopback/authentication';
import { inject } from '@loopback/core';
import { repository } from '@loopback/repository';
import { get, HttpErrors, post, requestBody } from '@loopback/rest';
import { securityId, UserProfile } from '@loopback/security';
import { authorize } from '../authorization';
import { CustomerRepository, EmployeeRepository, RolesRepository, UserRolesRepository, UsersRepository } from '../repositories';
import { BcryptHasher } from '../services/hash.password.bcrypt';
import { JWTService } from '../services/jwt-service';
import { RbacService } from '../services/rbac.service';
import { MyUserService } from '../services/user-service';
import { OtpService } from '../services/otp.service';
import { StoreScopeService } from '../services/store-scope.service';
import { NON_STAFF_ROLES, pickStaffRole } from '../utils/role-guard';

export class AuthController {
  constructor(
    @repository(UsersRepository)
    public usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @repository(EmployeeRepository)
    private employeeRepository: EmployeeRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('service.user.service')
    public userService: MyUserService,
    @inject('service.jwt.service')
    public jwtService: JWTService,
    @inject('services.rbac')
    public rbacService: RbacService,
    @inject('services.OtpService')
    public otpService: OtpService,
    @inject('services.store-scope')
    public storeScopeService: StoreScopeService,
  ) { }

  private async generateUniqueUsername(email: string | undefined, fullName: string): Promise<string> {
    const base = email
      ? email.split('@')[0].toLowerCase()
      : fullName.trim().toLowerCase().replace(/\s+/g, '.');
    let username = base;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await this.usersRepository.findOne({ where: { username } });
      if (!existing) return username;
      username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    throw new HttpErrors.InternalServerError('Could not generate a unique username');
  }

  // ---------------------------------------Super Admin Registration------------------------------------
  @post('/auth/super-admin/register')
  async createSuperAdmin(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['fullName', 'email', 'countryCode', 'phone', 'password'],
            properties: {
              fullName: { type: 'string' },
              email: { type: 'string', format: 'email' },
              countryCode: { type: 'string', default: '+91', description: 'Country code with + prefix (e.g., +91, +1, +44)' },
              phone: { type: 'string' },
              password: { type: 'string', minLength: 6 },
            },
          },
        },
      },
    })
    credentials: {
      fullName: string;
      email: string;
      countryCode: string;
      phone: string;
      password: string;
    },
  ): Promise<{ message: string; username: string }> {
    // Check if super admin already exists
    const existingSuperAdmin = await this.rolesRepository.findOne({
      where: { value: 'super_admin' },
      include: [{ relation: 'users' }],
    });

    if (existingSuperAdmin && existingSuperAdmin.users && existingSuperAdmin.users.length > 0) {
      throw new HttpErrors.BadRequest('Super admin already exists');
    }

    // Check if email or phone already exists
    const existingUser = await this.usersRepository.findOne({
      where: {
        or: [
          { email: credentials.email },
          { phone: credentials.phone }
        ]
      }
    });

    if (existingUser) {
      throw new HttpErrors.BadRequest('Email or phone already exists');
    }

    // Hash password
    const hashedPassword = await this.hasher.hashPassword(credentials.password);

    // Generate unique username from email prefix
    const username = await this.generateUniqueUsername(credentials.email, credentials.fullName);

    // Create user
    const user = await this.usersRepository.create({
      fullName: credentials.fullName,
      username,
      email: credentials.email,
      countryCode: credentials.countryCode || '+91',
      phone: credentials.phone,
      password: hashedPassword,
      isActive: true,
    });

    // Get or create super_admin role
    let superAdminRole = await this.rolesRepository.findOne({
      where: { value: 'super_admin' },
    });

    if (!superAdminRole) {
      superAdminRole = await this.rolesRepository.create({
        label: 'Super Admin',
        value: 'super_admin',
        description: 'Super Administrator',
      });
    }

    // Assign role to user
    await this.userRolesRepository.create({
      usersId: user.id,
      rolesId: superAdminRole.id,
    });

    return { message: 'Super admin created successfully', username };
  }

  // ---------------------------------------Login------------------------------------
  @post('/auth/login')
  async login(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['password'],
            properties: {
              email: { type: 'string', format: 'email' },
              username: { type: 'string' },
              password: { type: 'string' },
            },
          },
        },
      },
    })
    credentials: {
      username?: string;
      email?: string;
      password: string;
    },
  ): Promise<{ token: string; user: object }> {
    if (!credentials.email && !credentials.username) {
      throw new HttpErrors.BadRequest('Either email or username is required');
    }

    // Find user by email or username
    const where: object = credentials.email
      ? { email: credentials.email }
      : { username: credentials.username };

    const user = await this.usersRepository.findOne({
      where,
      include: [{ relation: 'roles' }],
    });

    if (!user) {
      throw new HttpErrors.Unauthorized('Invalid credentials');
    }

    if (!user.isActive) {
      throw new HttpErrors.Unauthorized('Account is inactive');
    }

    // Verify password
    const isPasswordValid = await this.hasher.comparePassword(
      credentials.password,
      user.password!,
    );

    if (!isPasswordValid) {
      throw new HttpErrors.Unauthorized('Invalid credentials');
    }

    // A user linked as both employee and customer holds both roles on one
    // login (see EmployeeController/CustomerController's linkExistingAccount
    // flow) — roles[0] is whatever order the DB join returns, not necessarily
    // the staff one. This is the *staff* login, so always prefer whichever
    // role actually carries admin-panel permissions.
    const primaryRole = pickStaffRole(user.roles);

    // Resolve the role's permissions so they can be embedded in the token.
    // Without this the JWT carries only roles, so any non-super_admin user gets
    // an empty permission set and the frontend hides everything.
    const roleValue = primaryRole.value;
    let permissions: string[] = [];
    try {
      const resolved = await this.rbacService.getUserRoleAndPermissionsByRole(user.id!, roleValue);
      permissions = resolved.permissions;
    } catch {
      // No permissions mapped for the role — proceed with an empty set.
      permissions = [];
    }

    // Resolve which stores this user may see and snapshot it into the token, so
    // scoping every later request costs no extra query. Like permissions, this is
    // fixed at login: moving an employee to another store requires a re-login.
    const storeScope = await this.storeScopeService.resolveForUser(user.id!, [roleValue]);
    const employee = await this.employeeRepository.findOne({
      where: { userId: user.id, isDeleted: false },
      fields: { id: true, storeId: true, firstName: true, lastName: true },
    });
    // Only a genuinely store-scoped employee has an authoritative "their one
    // store" — a cluster/region-scoped employee can carry a stale storeId
    // left over from before their role was re-scoped, and exposing it here
    // would make the frontend (e.g. New Order's store auto-assign) wrongly
    // pin them to that one old store instead of letting them work across
    // their whole cluster/region.
    const singleStoreId = storeScope.scopeLevel === 'store' ? employee?.storeId ?? null : null;

    // Same reasoning as /auth/me: Users.fullName is the account's own name,
    // not necessarily the profile name kept current via Employee/Customer
    // Master. This is the staff login, so it's practically always the
    // employee branch — the customer check is just for the rare dual-linked
    // account whose only assignable role turned out to be the customer one.
    let resolvedFullName = user.fullName;
    if (roleValue === 'super_admin') {
      resolvedFullName = user.fullName;
    } else if (NON_STAFF_ROLES.includes(roleValue)) {
      const customer = await this.customerRepository.findOne({
        where: { userId: user.id, isDeleted: false } as object,
        fields: { firstName: true, lastName: true } as object,
      });
      if (customer) {
        resolvedFullName = `${customer.firstName} ${customer.lastName}`.trim();
      }
    } else if (employee) {
      resolvedFullName = `${employee.firstName} ${employee.lastName}`.trim();
    }

    // Generate JWT token (roles + permissions + store scope all travel in the token —
    // verifyToken reads them back for both frontend gating and backend authz).
    const userProfile = this.userService.convertToUserProfile(user);
    const token = await this.jwtService.generateToken({
      ...userProfile,
      fullName: resolvedFullName,
      roles: [roleValue],
      permissions,
      storeId: singleStoreId,
      storeScope: this.storeScopeService.toClaim(storeScope),
    });

    return {
      token,
      user: {
        id: user.id,
        fullName: resolvedFullName,
        email: user.email,
        countryCode: user.countryCode,
        phone: user.phone,
        roles: [roleValue],
        permissions,
        storeId: singleStoreId,
      },
    };
  }

  // ---------------------------------------Update Password------------------------------------
  @authenticate('jwt')
  @authorize({ roles: ['super_admin', 'client'] })
  @post('/auth/update-password')
  async updatePassword(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['oldPassword', 'newPassword'],
            properties: {
              oldPassword: { type: 'string' },
              newPassword: { type: 'string', minLength: 6 },
            },
          },
        },
      },
    })
    passwords: {
      oldPassword: string;
      newPassword: string;
    },
  ): Promise<{ message: string }> {
    const userId = currentUser[securityId];

    const user = await this.usersRepository.findById(userId);

    // Verify old password
    const isOldPasswordValid = await this.hasher.comparePassword(
      passwords.oldPassword,
      user.password!,
    );

    if (!isOldPasswordValid) {
      throw new HttpErrors.BadRequest('Old password is incorrect');
    }

    // Hash new password
    const hashedPassword = await this.hasher.hashPassword(passwords.newPassword);

    // Update password
    await this.usersRepository.updateById(userId, {
      password: hashedPassword,
    });

    return { message: 'Password updated successfully' };
  }

  // ---------------------------------------Get Current User------------------------------------
  @authenticate('jwt')
  @get('/auth/me')
  async whoAmI(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const userId = currentUser[securityId];

    const user = await this.usersRepository.findById(userId, {
      include: [{ relation: 'roles' }],
    });

    const employee = await this.employeeRepository.findOne({
      where: { userId, isDeleted: false },
      fields: { id: true, storeId: true, firstName: true, lastName: true },
    });
    // Same reasoning as login: only expose storeId when the role is actually
    // store-scoped, or a cluster/region-scoped employee's stale leftover
    // storeId gets treated as authoritative by the frontend.
    const roles = (currentUser.roles as string[]) ?? [];
    const storeScope = await this.storeScopeService.resolveForUser(String(userId), roles);
    const singleStoreId = storeScope.scopeLevel === 'store' ? employee?.storeId ?? null : null;

    // Users.fullName is the account's own name — but for a staff or customer
    // session it should reflect that PROFILE's name (kept up to date via
    // Employee Master / Customer Master edits), not whatever was typed in at
    // account creation. super_admin has no such profile, so it's the one
    // case that genuinely reads straight off Users.
    let resolvedFullName = user.fullName;
    if (roles.includes('super_admin')) {
      resolvedFullName = user.fullName;
    } else if (roles.some(role => NON_STAFF_ROLES.includes(role))) {
      const customer = await this.customerRepository.findOne({
        where: { userId, isDeleted: false } as object,
        fields: { firstName: true, lastName: true } as object,
      });
      if (customer) {
        resolvedFullName = `${customer.firstName} ${customer.lastName}`.trim();
      }
    } else if (employee) {
      resolvedFullName = `${employee.firstName} ${employee.lastName}`.trim();
    }

    return {
      id: user.id,
      fullName: resolvedFullName,
      email: user.email,
      countryCode: user.countryCode,
      phone: user.phone,
      roles: currentUser.roles,
      employeeId: employee?.id ?? null,
      storeId: singleStoreId,
    };
  }

  // ---------------------------------------Client Registration------------------------------------
  @post('/auth/client/register')
  async clientRegistration(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['fullName', 'countryCode', 'phone', 'password'],
            properties: {
              fullName: { type: 'string' },
              email: { type: 'string', format: 'email' },
              countryCode: { type: 'string', default: '+91', description: 'Country code with + prefix (e.g., +91, +1, +44)' },
              phone: { type: 'string' },
              password: { type: 'string', minLength: 6 },
            },
          },
        },
      },
    })
    credentials: {
      fullName: string;
      email?: string;
      countryCode: string;
      phone: string;
      password: string;
    },
  ): Promise<{ message: string; username: string }> {
    // Check if email or phone already exists
    const orConditions: object[] = [{ phone: credentials.phone }];
    if (credentials.email) orConditions.push({ email: credentials.email });

    const existingUser = await this.usersRepository.findOne({
      where: { or: orConditions },
    });

    if (existingUser) {
      throw new HttpErrors.BadRequest('Email or phone already exists');
    }

    // Hash password
    const hashedPassword = await this.hasher.hashPassword(credentials.password);

    // Generate unique username: email prefix if available, else fullName
    const username = await this.generateUniqueUsername(credentials.email, credentials.fullName);

    // Create user
    const user = await this.usersRepository.create({
      fullName: credentials.fullName,
      username,
      ...(credentials.email && { email: credentials.email }),
      countryCode: credentials.countryCode || '+91',
      phone: credentials.phone,
      password: hashedPassword,
      isActive: true,
    });

    // Get or create client role
    let clientRole = await this.rolesRepository.findOne({
      where: { value: 'client' },
    });

    if (!clientRole) {
      clientRole = await this.rolesRepository.create({
        label: 'Client',
        value: 'client',
        description: 'Client User',
      });
    }

    // Assign role to user
    await this.userRolesRepository.create({
      usersId: user.id,
      rolesId: clientRole.id,
    });

    return { message: 'Client registered successfully', username };
  }

  // ---------------------------------------Forgot Password: Send OTP------------------------------------
  @post('/auth/forget-password/send-email-otp')
  async forgetPasswordSendOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', format: 'email' },
            },
          },
        },
      },
    })
    body: { email: string },
  ): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({
      where: { email: body.email },
    });

    if (!user) {
      throw new HttpErrors.BadRequest("User don't exist, Please register");
    }

    const otp = this.otpService.generateOtp();
    const hashedOtp = await this.hasher.hashPassword(otp);

    // Set expiry to 10 minutes from now
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 10);

    await this.usersRepository.updateById(user.id, {
      resetPasswordOtp: hashedOtp,
      resetPasswordOtpExpires: expiry,
    });

    await this.otpService.sendOtpEmail(user.email!, otp);

    return { message: 'If the email exists, an OTP will be sent.' };
  }

  // ---------------------------------------Forgot Password: Verify OTP------------------------------------
  @post('/auth/forget-password/verify-email-otp')
  async verifyEmailOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['email', 'otp'],
            properties: {
              email: { type: 'string', format: 'email' },
              otp: { type: 'string' },
            },
          },
        },
      },
    })
    body: {
      email: string;
      otp: string;
    },
  ): Promise<{ message: string; verified: boolean }> {
    const user = await this.usersRepository.findOne({
      where: { email: body.email },
    });

    if (!user || !user.resetPasswordOtp || !user.resetPasswordOtpExpires) {
      throw new HttpErrors.BadRequest('Invalid OTP or email');
    }

    if (new Date() > new Date(user.resetPasswordOtpExpires)) {
      throw new HttpErrors.BadRequest('OTP has expired');
    }

    const isOtpValid = await this.hasher.comparePassword(body.otp, user.resetPasswordOtp);

    if (!isOtpValid) {
      throw new HttpErrors.BadRequest('Invalid OTP');
    }

    return { message: 'OTP verified successfully', verified: true };
  }

  // ---------------------------------------Forgot Password: Reset Password------------------------------------
  @post('/auth/reset-password')
  async resetPassword(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['email', 'otp', 'newPassword'],
            properties: {
              email: { type: 'string', format: 'email' },
              otp: { type: 'string' },
              newPassword: { type: 'string', minLength: 6 },
            },
          },
        },
      },
    })
    body: {
      email: string;
      otp: string;
      newPassword: string;
    },
  ): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({
      where: { email: body.email },
    });

    if (!user || !user.resetPasswordOtp || !user.resetPasswordOtpExpires) {
      throw new HttpErrors.BadRequest('Invalid OTP or email');
    }

    if (new Date() > new Date(user.resetPasswordOtpExpires)) {
      throw new HttpErrors.BadRequest('OTP has expired');
    }

    const isOtpValid = await this.hasher.comparePassword(body.otp, user.resetPasswordOtp);

    if (!isOtpValid) {
      throw new HttpErrors.BadRequest('Invalid OTP');
    }

    const hashedNewPassword = await this.hasher.hashPassword(body.newPassword);

    await this.usersRepository.updateById(user.id, {
      password: hashedNewPassword,
      resetPasswordOtp: undefined,
      resetPasswordOtpExpires: undefined,
    });

    return { message: 'Password reset successfully' };
  }
}
