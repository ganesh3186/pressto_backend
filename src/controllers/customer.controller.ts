import { authenticate } from '@loopback/authentication';
import { inject } from '@loopback/core';
import { Filter, FilterExcludingWhere, IsolationLevel, repository } from '@loopback/repository';
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
import { authorize } from '../authorization';
import { PresstoDataSource } from '../datasources';
import { Customer } from '../models';
import { PaymentMode } from '../models/payment-mode.enum';
import {
  CustomerLabelAssignmentRepository,
  CustomerRepository,
  CustomerSecurityDepositRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
  WalletRepository,
} from '../repositories';
import { BcryptHasher } from '../services/hash.password.bcrypt';
import { SecurityDepositService } from '../services/security-deposit.service';
import { WalletService } from '../services/wallet.service';
import { PROTECTED_ROLES } from '../utils/role-guard';

// The only role a customer account ever gets — never accepted from the
// frontend (a customer:create/update caller has no business choosing an
// arbitrary role, e.g. accidentally or maliciously granting admin-panel
// permissions to what's supposed to be a plain customer login).
const CUSTOMER_ROLE_VALUE = 'customer';

export class CustomerController {
  constructor(
    @repository(CustomerRepository)
    public customerRepository: CustomerRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @repository(CustomerSecurityDepositRepository)
    private customerSecurityDepositRepository: CustomerSecurityDepositRepository,
    @repository(CustomerLabelAssignmentRepository)
    private customerLabelAssignmentRepository: CustomerLabelAssignmentRepository,
    @repository(WalletRepository)
    private walletRepository: WalletRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
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

  /**
   * The `customer` role, creating it on first use if the seed has not run yet.
   * Self-healing so customer creation never depends on seed order — mirrors
   * RiderController.resolveRiderRole.
   */
  private async resolveCustomerRole() {
    const existing = await this.rolesRepository.findOne({ where: { value: CUSTOMER_ROLE_VALUE } });
    if (existing) return existing;
    return this.rolesRepository.create({
      value: CUSTOMER_ROLE_VALUE,
      label: 'Customer',
      description: 'Customer web/app account — own profile, orders and wallet.',
      isLocked: true,
      loginAccess: true,
      scope: 'store',
      isActive: true,
      isDeleted: false,
    });
  }

  private async generateCustomerCode(): Promise<string> {
    const lastCustomer = await this.customerRepository.findOne({
      order: ['createdAt DESC'],
      fields: { customerCode: true },
    });
    if (!lastCustomer?.customerCode) {
      return 'CUST0001';
    }
    const numPart = parseInt(lastCustomer.customerCode.replace('CUST', ''), 10);
    const nextNum = (isNaN(numPart) ? 0 : numPart) + 1;
    return `CUST${String(nextNum).padStart(4, '0')}`;
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:create']})
  @post('/customers')
  @response(200, { description: 'Customer created' })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['firstName', 'lastName', 'countryCode', 'phone'],
            properties: {
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              countryCode: { type: 'string', default: '+91' },
              phone: { type: 'string' },
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 6 },
              customerEntityType: { type: 'string', enum: ['individual', 'business'] },
              // customerTypeId: {type: 'string', format: 'uuid'},
              // On-account eligibility for an `individual` customer — a
              // `business` customer is always eligible regardless of this.
              isOnAccountEligible: { type: 'boolean' },
              customerLabelIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              customerGroupId: { type: 'string', format: 'uuid' },
              gstNumber: { type: 'string' },
              panNumber: { type: 'string' },
              companyName: { type: 'string' },
              preferredPaymentMode: { type: 'string', enum: Object.values(PaymentMode) },
              dateOfBirth: { type: 'string', format: 'date' },
              preferredStoreId: { type: 'string', format: 'uuid' },
              sensitivityScore: { type: 'number' },
              notes: { type: 'string' },
              defaultDiscountType: { type: 'string' },
              defaultDiscountValue: { type: 'number' },
              linkExistingAccount: {
                type: 'boolean',
                description:
                  'Must be explicitly true to attach this customer profile to an existing ' +
                  'login found by phone/email (e.g. an employee who is also a customer). ' +
                  'Without it, a match returns a 409 so the operator can confirm before accounts are linked.',
              },
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
      customerEntityType?: 'individual' | 'business';
      // customerTypeId: string;
      isOnAccountEligible?: boolean;
      customerLabelIds?: string[];
      customerGroupId: string;
      gstNumber?: string;
      panNumber?: string;
      companyName?: string;
      preferredPaymentMode?: PaymentMode;
      dateOfBirth?: string;
      preferredStoreId?: string;
      sensitivityScore?: number;
      notes?: string;
      defaultDiscountType?: string;
      defaultDiscountValue?: number;
      linkExistingAccount?: boolean;
    },
  ): Promise<object> {
    // Employees and customers share the users table. A phone/email match here
    // is a real scenario (staff who's also a paying customer) — but, mirroring
    // the same guard on the employee side, it must never land on the
    // super_admin account, and it must never happen silently: the caller has
    // to resend with linkExistingAccount: true after being shown who they'd
    // be linking to. The existing login's own identity fields are left as-is.
    const orConditions: object[] = [{ phone: body.phone }];
    if (body.email) orConditions.push({ email: body.email });
    const existingUser = await this.usersRepository.findOne({
      where: { or: orConditions },
      include: [{ relation: 'roles' }],
    });
    if (existingUser) {
      const existingRoleValues = (existingUser.roles ?? []).map(r => r.value);
      if (PROTECTED_ROLES.some(r => existingRoleValues.includes(r))) {
        throw new HttpErrors.Conflict(
          'That phone or email belongs to a protected system account and cannot be turned into a customer.',
        );
      }

      const alreadyCustomer = await this.customerRepository.findOne({
        where: { userId: existingUser.id, isDeleted: false },
      });
      if (alreadyCustomer) {
        throw new HttpErrors.Conflict(
          `That phone or email already belongs to customer ${alreadyCustomer.customerCode}.`,
        );
      }

      if (!body.linkExistingAccount) {
        throw new HttpErrors.Conflict(
          JSON.stringify({
            code: 'EXISTING_ACCOUNT_MATCH',
            message: 'That phone or email already belongs to an existing account. ' +
              'Resend with linkExistingAccount: true to attach a customer profile to it.',
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

    const customerRole = await this.resolveCustomerRole();

    const rawPassword = body.password ?? 'Pressto@1234';
    const hashedPassword = await this.hasher.hashPassword(rawPassword);
    const customerCode = await this.generateCustomerCode();

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      // Reuse the existing login when linking to an already-confirmed match —
      // their password and identity fields are left alone.
      const user = existingUser
        ? existingUser
        : await this.usersRepository.create(
            {
              fullName: `${body.firstName} ${body.lastName}`,
              username: await this.generateUniqueUsername(body.email, `${body.firstName} ${body.lastName}`),
              ...(body.email && { email: body.email }),
              countryCode: body.countryCode || '+91',
              phone: body.phone,
              password: hashedPassword,
              isActive: true,
            },
            { transaction: tx },
          );

      const customer = await this.customerRepository.create(
        {
          userId: user.id,
          customerCode,
          firstName: body.firstName,
          lastName: body.lastName,
          ...(body.email && { email: body.email }),
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
          customerEntityType: body.customerEntityType ?? 'individual',
          isOnAccountEligible: body.isOnAccountEligible ?? false,
          customerGroupId: body.customerGroupId,
          gstNumber: body.gstNumber,
          panNumber: body.panNumber,
          companyName: body.companyName,
          preferredPaymentMode: body.preferredPaymentMode,
          preferredStoreId: body.preferredStoreId,
          sensitivityScore: body.sensitivityScore,
          notes: body.notes,
          defaultDiscountType: body.defaultDiscountType,
          defaultDiscountValue: body.defaultDiscountValue,
        },
        { transaction: tx },
      );

      // An existing login (e.g. an employee who's also a customer) may already
      // hold the customer role — adding it twice would leave a duplicate row.
      const alreadyAssigned = existingUser
        ? await this.userRolesRepository.findOne({
            where: { usersId: user.id, rolesId: customerRole.id },
          })
        : null;
      if (!alreadyAssigned) {
        await this.userRolesRepository.create(
          { usersId: user.id, rolesId: customerRole.id },
          { transaction: tx },
        );
      }

      for (const labelId of body.customerLabelIds ?? []) {
        await this.customerLabelAssignmentRepository.create(
          { customerId: customer.id, customerLabelId: labelId },
          { transaction: tx },
        );
      }

      await this.walletService.createWallet(customer.id, { transaction: tx });
      await this.securityDepositService.createDeposit(customer.id, { transaction: tx });

      await tx.commit();

      return {
        message: 'Customer created successfully',
        customer: { ...customer, user: { ...user, password: undefined } },
        assignedRoles: [CUSTOMER_ROLE_VALUE],
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:read']})
  @get('/customers')
  @response(200, {
    description: 'Array of Customer model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Customer, { includeRelations: true }),
        },
      },
    },
  })
  async find(@param.filter(Customer) filter?: Filter<Customer>): Promise<Customer[]> {
    return this.customerRepository.find({
      ...filter,
      where: { and: [{ isDeleted: false }, filter?.where ?? {}] },
      order: ['createdAt DESC'],
      include: [
        {
          relation: 'user',
          scope: {
            fields: { id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true },
            include: [{ relation: 'roles' }],
          },
        },
        {
          relation: 'customerLabels',
          scope: {
            fields: { id: true, name: true, code: true },
          },
        }
      ],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:read']})
  @get('/customers/{id}')
  @response(200, {
    description: 'Customer model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Customer, { includeRelations: true }),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Customer, { exclude: 'where' }) filter?: FilterExcludingWhere<Customer>,
  ): Promise<object> {
    const customer = await this.customerRepository.findById(id, {
      ...filter,
      include: [
        {
          relation: 'user',
          scope: {
            fields: { id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true },
            include: [{ relation: 'roles' }],
          },
        },
        {
          relation: 'customerLabels',
          scope: {
            fields: { id: true, name: true, code: true },
          },
        },
      ],
    });

    const [wallet, securityDeposit] = await Promise.all([
      this.walletRepository.findOne({ where: { customerId: id } }),
      this.customerSecurityDepositRepository.findOne({ where: { customerId: id } }),
    ]);

    return { ...customer, wallet, securityDeposit };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer:update']})
  @patch('/customers/{id}')
  @response(200, { description: 'Customer updated' })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // user fields
              fullName: { type: 'string' },
              email: { type: 'string', format: 'email' },
              countryCode: { type: 'string' },
              phone: { type: 'string' },
              isActive: { type: 'boolean' },
              // customer fields
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              dateOfBirth: { type: 'string', format: 'date' },
              customerEntityType: { type: 'string', enum: ['individual', 'business'] },
              // customerTypeId: { type: 'string', format: 'uuid' },
              isOnAccountEligible: { type: 'boolean' },
              customerLabelIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              customerGroupId: { type: 'string', format: 'uuid' },
              gstNumber: { type: 'string' },
              panNumber: { type: 'string' },
              companyName: { type: 'string' },
              preferredPaymentMode: { type: 'string', enum: Object.values(PaymentMode) },
              loyaltyPoints: { type: 'number' },
              defaultDiscountType: { type: 'string' },
              defaultDiscountValue: { type: 'number' },
              preferredStoreId: { type: 'string', format: 'uuid' },
              sensitivityScore: { type: 'number' },
              notes: { type: 'string' },
              statusChangeRemark: { type: 'string' },
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
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
      customerEntityType?: 'individual' | 'business';
      // customerTypeId?: string;
      isOnAccountEligible?: boolean;
      customerLabelIds?: string[];
      customerGroupId?: string;
      gstNumber?: string;
      panNumber?: string;
      companyName?: string;
      preferredPaymentMode?: PaymentMode;
      loyaltyPoints?: number;
      defaultDiscountType?: string;
      defaultDiscountValue?: number;
      preferredStoreId?: string;
      sensitivityScore?: number;
      notes?: string;
      statusChangeRemark?: string;
    },
  ): Promise<void> {
    const customer = await this.customerRepository.findById(id);

    // Role management is deliberately not exposed here — a customer account
    // always has exactly the customer role (set once at create), never
    // reassignable through this endpoint.
    const { customerLabelIds, ...rest } = body;

    const userFields: Record<string, unknown> = {};
    const customerFields: Record<string, unknown> = {};

    const userKeys = ['fullName', 'email', 'countryCode', 'phone', 'isActive'];
    const customerKeys = [
      'firstName', 'lastName', 'customerEntityType', 'isOnAccountEligible', 'customerGroupId',
      'gstNumber', 'panNumber', 'companyName', 'preferredPaymentMode', 'loyaltyPoints', 'defaultDiscountType',
      'defaultDiscountValue', 'preferredStoreId', 'sensitivityScore', 'notes',
      'statusChangeRemark',
    ];

    for (const [key, value] of Object.entries(rest)) {
      if (userKeys.includes(key)) userFields[key] = value;
      else if (customerKeys.includes(key)) customerFields[key] = value;
    }

    if (rest.dateOfBirth) customerFields.dateOfBirth = new Date(rest.dateOfBirth);
    // isActive must be kept in sync on both tables
    if (rest.isActive !== undefined) customerFields.isActive = rest.isActive;

    // Create() checks phone/email uniqueness up front; edits must too, or a
    // typo silently gives two different logins the same phone/email.
    if (userFields.phone || userFields.email) {
      const orConditions: object[] = [];
      if (userFields.phone) orConditions.push({ phone: userFields.phone });
      if (userFields.email) orConditions.push({ email: userFields.email });
      const collision = await this.usersRepository.findOne({
        where: { and: [{ or: orConditions }, { id: { neq: customer.userId } }] },
      });
      if (collision) {
        throw new HttpErrors.Conflict('That phone or email is already used by another account.');
      }
    }

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      if (Object.keys(userFields).length > 0) {
        await this.usersRepository.updateById(customer.userId, userFields, { transaction: tx });
      }

      if (Object.keys(customerFields).length > 0) {
        await this.customerRepository.updateById(id, customerFields, { transaction: tx });
      }

      // Distinguish "field omitted" (leave labels alone) from "sent as []"
      // (clear every label) — unlike roleValues, a customer can validly have
      // zero labels, so an empty array must actually take effect.
      if (customerLabelIds !== undefined) {
        await this.customerLabelAssignmentRepository.deleteAll(
          { customerId: id },
          { transaction: tx },
        );
        for (const labelId of customerLabelIds) {
          await this.customerLabelAssignmentRepository.create(
            { customerId: id, customerLabelId: labelId },
            { transaction: tx },
          );
        }
      }

      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
