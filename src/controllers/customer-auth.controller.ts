import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {HttpErrors, post, requestBody, response} from '@loopback/rest';
import {securityId} from '@loopback/security';
import {PresstoDataSource} from '../datasources';
import {
  CustomerRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
} from '../repositories';
import {BcryptHasher} from '../services/hash.password.bcrypt';
import {JWTService} from '../services/jwt-service';
import {SecurityDepositService} from '../services/security-deposit.service';
import {WalletService} from '../services/wallet.service';
import {PROTECTED_ROLES, sortCustomerRoleFirst} from '../utils/role-guard';

export class CustomerAuthController {
  constructor(
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('service.jwt.service')
    private jwtService: JWTService,
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
  ) {}

  private async generateUniqueUsername(email: string | undefined, fullName: string): Promise<string> {
    const base = email
      ? email.split('@')[0].toLowerCase()
      : fullName.trim().toLowerCase().replace(/\s+/g, '.');
    let username = base;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await this.usersRepository.findOne({where: {username}});
      if (!existing) return username;
      username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    throw new HttpErrors.InternalServerError('Could not generate a unique username');
  }

  private async generateCustomerCode(): Promise<string> {
    const lastCustomer = await this.customerRepository.findOne({
      order: ['createdAt DESC'],
      fields: {customerCode: true},
    });
    if (!lastCustomer?.customerCode) {
      return 'CUST0001';
    }
    const numPart = parseInt(lastCustomer.customerCode.replace('CUST', ''), 10);
    const nextNum = (isNaN(numPart) ? 0 : numPart) + 1;
    return `CUST${String(nextNum).padStart(4, '0')}`;
  }

  // ---------------------------------------Customer Registration------------------------------------
  @post('/auth/customer/register')
  @response(200, {description: 'Customer registered successfully'})
  async register(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['firstName', 'lastName', 'countryCode', 'phone'],
            properties: {
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              countryCode: {type: 'string', default: '+91'},
              phone: {type: 'string'},
              email: {type: 'string', format: 'email'},
              password: {type: 'string', minLength: 6},
            },
          },
        },
      },
    })
    body: {
      firstName: string;
      lastName: string;
      countryCode: string;
      phone: string;
      email?: string;
      password?: string;
    },
  ): Promise<{message: string; username: string}> {
    // This endpoint is public and unauthenticated — there is no operator here
    // to show a "link to existing account?" confirmation like the admin panel
    // does. So a phone/email match is handled differently depending on what's
    // already there:
    //   - already a customer  -> genuine duplicate, reject.
    //   - protected account (super_admin) -> never touch it, reject.
    //   - an existing login with no customer profile yet (e.g. an employee
    //     self-registering as a customer) -> only auto-link if BOTH phone AND
    //     email match that account exactly. An exact match on both fields is
    //     the one signal a public endpoint can trust without an operator or
    //     an OTP step; a partial match (phone right, email wrong, or missing)
    //     is treated as a stranger and rejected, not silently linked.
    const orConditions: object[] = [{phone: body.phone}];
    if (body.email) orConditions.push({email: body.email});
    const existingUser = await this.usersRepository.findOne({
      where: {or: orConditions},
      include: [{relation: 'roles'}],
    });

    let linkedUser: typeof existingUser | null = null;

    if (existingUser) {
      const existingRoleValues = (existingUser.roles ?? []).map(r => r.value);
      if (PROTECTED_ROLES.some(r => existingRoleValues.includes(r))) {
        throw new HttpErrors.Conflict('That phone or email belongs to a protected system account.');
      }

      const alreadyCustomer = await this.customerRepository.findOne({
        where: {userId: existingUser.id, isDeleted: false},
      });
      if (alreadyCustomer) {
        throw new HttpErrors.BadRequest(
          'An account with this phone or email is already registered. Please log in instead.',
        );
      }

      const phoneMatches = existingUser.phone === body.phone;
      const emailMatches =
        Boolean(body.email) &&
        Boolean(existingUser.email) &&
        existingUser.email!.toLowerCase() === body.email!.toLowerCase();

      if (!phoneMatches || !emailMatches) {
        throw new HttpErrors.Conflict(
          'That phone or email is already linked to a different account. ' +
            'Provide the exact phone and email already on file, or contact support.',
        );
      }

      linkedUser = existingUser;
    }

    const customerCode = await this.generateCustomerCode();

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      // Reuse the existing login when it's a confirmed exact match — never
      // touch its identity fields (name/email/phone/password stay as-is).
      const user = linkedUser
        ? linkedUser
        : await this.usersRepository.create(
            {
              fullName: `${body.firstName} ${body.lastName}`,
              username: await this.generateUniqueUsername(body.email, `${body.firstName} ${body.lastName}`),
              ...(body.email && {email: body.email}),
              countryCode: body.countryCode || '+91',
              phone: body.phone,
              password: await this.hasher.hashPassword(body.password ?? 'Pressto@1234'),
              isActive: true,
            },
            {transaction: tx},
          );

      // Get or create 'customer' role
      let customerRole = await this.rolesRepository.findOne({where: {value: 'customer'}});
      if (!customerRole) {
        customerRole = await this.rolesRepository.create(
          {label: 'Customer', value: 'customer', description: 'Customer User'},
          {transaction: tx},
        );
      }

      const alreadyHasRole = linkedUser
        ? await this.userRolesRepository.findOne({
            where: {usersId: user.id, rolesId: customerRole.id},
          })
        : null;
      if (!alreadyHasRole) {
        await this.userRolesRepository.create(
          {usersId: user.id, rolesId: customerRole.id},
          {transaction: tx},
        );
      }

      const customer = await this.customerRepository.create(
        {
          userId: user.id,
          customerCode,
          firstName: body.firstName,
          lastName: body.lastName,
          ...(body.email && {email: body.email}),
        },
        {transaction: tx},
      );

      await this.walletService.createWallet(customer.id, {transaction: tx});
      await this.securityDepositService.createDeposit(customer.id, {transaction: tx});

      await tx.commit();

      return {message: 'Customer registered successfully', username: user.username};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ---------------------------------------Send OTP------------------------------------
  @post('/auth/customer/send-otp')
  @response(200, {description: 'OTP sent'})
  async sendOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['phone', 'countryCode'],
            properties: {
              phone: {type: 'string'},
              countryCode: {type: 'string'},
            },
          },
        },
      },
    })
    body: {phone: string; countryCode: string},
  ): Promise<object> {
    const user = await this.usersRepository.findOne({
      where: {phone: body.phone, countryCode: body.countryCode},
    });

    if (!user) {
      throw new HttpErrors.BadRequest('User not found with this phone number.');
    }

    // Check customer record exists
    const customer = await this.customerRepository.findOne({where: {userId: user.id}});
    if (!customer) {
      throw new HttpErrors.BadRequest('No customer record associated with this user.');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await this.hasher.hashPassword(otp);

    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 10);

    await this.usersRepository.updateById(user.id, {
      loginOtp: hashedOtp,
      loginOtpExpires: expiry,
    });

    // TODO: Replace with SMS service in production
    return {message: 'OTP sent', otp};
  }

  // ---------------------------------------Verify OTP------------------------------------
  @post('/auth/customer/verify-otp')
  @response(200, {description: 'OTP verified, token returned'})
  async verifyOtp(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['phone', 'countryCode', 'otp'],
            properties: {
              phone: {type: 'string'},
              countryCode: {type: 'string'},
              otp: {type: 'string'},
            },
          },
        },
      },
    })
    body: {phone: string; countryCode: string; otp: string},
  ): Promise<object> {
    const user = await this.usersRepository.findOne({
      where: {phone: body.phone, countryCode: body.countryCode},
      include: [{relation: 'roles'}],
    });

    if (!user) {
      throw new HttpErrors.BadRequest('User not found with this phone number.');
    }

    // Check customer record exists
    const customer = await this.customerRepository.findOne({where: {userId: user.id}});
    if (!customer) {
      throw new HttpErrors.BadRequest('No customer record associated with this user.');
    }

    if (!user.loginOtp || !user.loginOtpExpires) {
      throw new HttpErrors.BadRequest('No OTP requested. Please request an OTP first.');
    }

    if (new Date() > new Date(user.loginOtpExpires)) {
      throw new HttpErrors.BadRequest('OTP has expired. Please request a new OTP.');
    }

    const isOtpValid = await this.hasher.comparePassword(body.otp, user.loginOtp);
    if (!isOtpValid) {
      throw new HttpErrors.BadRequest('Invalid OTP.');
    }

    // Clear OTP fields
    await this.usersRepository.updateById(user.id, {
      loginOtp: undefined,
      loginOtpExpires: undefined,
    });

    // Generate JWT token. This is the *customer* app session — a login also
    // linked to a staff role (see register()'s exact-match linking) must
    // still present as "customer" first here, never as whatever staff role
    // it also holds. Mirrors pickStaffRole on the admin-login side.
    const roles = sortCustomerRoleFirst(user.roles ?? []).map(r => r.value);
    const userProfile = {
      [securityId]: user.id!,
      id: user.id!,
      email: user.email,
      phone: user.phone,
      roles,
    };
    const token = await this.jwtService.generateToken(userProfile as any);

    return {
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        roles,
      },
    };
  }
}
