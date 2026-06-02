import { authenticate, AuthenticationBindings } from '@loopback/authentication';
import { inject } from '@loopback/core';
import { repository } from '@loopback/repository';
import { get, HttpErrors, post, requestBody } from '@loopback/rest';
import { securityId, UserProfile } from '@loopback/security';
import { authorize } from '../authorization';
import { RolesRepository, UserRolesRepository, UsersRepository } from '../repositories';
import { BcryptHasher } from '../services/hash.password.bcrypt';
import { JWTService } from '../services/jwt-service';
import { RbacService } from '../services/rbac.service';
import { MyUserService } from '../services/user-service';
import { OtpService } from '../services/otp.service';

export class AuthController {
  constructor(
    @repository(UsersRepository)
    public usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
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
  ) { }

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
  ): Promise<{ message: string }> {
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

    // Create user
    const user = await this.usersRepository.create({
      fullName: credentials.fullName,
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

    return { message: 'Super admin created successfully' };
  }

  // ---------------------------------------Login------------------------------------
  @post('/auth/login')
  async login(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string' },
            },
          },
        },
      },
    })
    credentials: {
      email: string;
      password: string;
    },
  ): Promise<{ token: string; user: object }> {
    // Find user by email
    const user = await this.usersRepository.findOne({
      where: { email: credentials.email },
      include: [{ relation: 'roles' }],
    });

    if (!user) {
      throw new HttpErrors.Unauthorized('Invalid email or password');
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
      throw new HttpErrors.Unauthorized('Invalid email or password');
    }

    // Generate JWT token
    const userProfile = this.userService.convertToUserProfile(user);
    const token = await this.jwtService.generateToken({ ...userProfile, roles: ['client'] });

    return {
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        countryCode: user.countryCode,
        phone: user.phone,
        roles: ['client'],
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

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      countryCode: user.countryCode,
      phone: user.phone,
      roles: currentUser.roles
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
  ): Promise<{ message: string }> {
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

    // Create user
    const user = await this.usersRepository.create({
      fullName: credentials.fullName,
      email: credentials.email,
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

    return { message: 'Client registered successfully' };
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

    await this.otpService.sendOtpEmail(user.email, otp);

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
