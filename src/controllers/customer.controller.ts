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
import {
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
  @authorize({ roles: ['super_admin'] })
  @post('/customers')
  @response(200, { description: 'Customer created' })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['firstName', 'lastName', 'countryCode', 'phone', 'roleValues'],
            properties: {
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              countryCode: { type: 'string', default: '+91' },
              phone: { type: 'string' },
              roleValues: { type: 'array', items: { type: 'string' } },
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 6 },
              customerEntityType: { type: 'string', enum: ['individual', 'business'] },
              // customerTypeId: {type: 'string', format: 'uuid'},
              customerLabelId: { type: 'string', format: 'uuid' },
              customerGroupId: { type: 'string', format: 'uuid' },
              gstNumber: { type: 'string' },
              companyName: { type: 'string' },
              dateOfBirth: { type: 'string', format: 'date' },
              preferredStoreId: { type: 'string', format: 'uuid' },
              sensitivityScore: { type: 'number' },
              notes: { type: 'string' },
              defaultDiscountType: { type: 'string' },
              defaultDiscountValue: { type: 'number' },
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
      roleValues: string[];
      email?: string;
      password?: string;
      customerEntityType?: 'individual' | 'business';
      // customerTypeId: string;
      customerLabelId: string;
      customerGroupId: string;
      gstNumber?: string;
      companyName?: string;
      dateOfBirth?: string;
      preferredStoreId?: string;
      sensitivityScore?: number;
      notes?: string;
      defaultDiscountType?: string;
      defaultDiscountValue?: number;
    },
  ): Promise<object> {
    // Check uniqueness
    const orConditions: object[] = [{ phone: body.phone }];
    if (body.email) orConditions.push({ email: body.email });
    const existingUser = await this.usersRepository.findOne({ where: { or: orConditions } });
    if (existingUser) {
      throw new HttpErrors.BadRequest('Email or phone already in use.');
    }

    const roles = await Promise.all(
      body.roleValues.map(async v => {
        const role = await this.rolesRepository.findOne({ where: { value: v } });
        if (!role) throw new HttpErrors.BadRequest(`Role not found: ${v}`);
        return role;
      }),
    );

    const rawPassword = body.password ?? 'Pressto@1234';
    const hashedPassword = await this.hasher.hashPassword(rawPassword);
    const username = await this.generateUniqueUsername(body.email, `${body.firstName} ${body.lastName}`);
    const customerCode = await this.generateCustomerCode();

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const user = await this.usersRepository.create(
        {
          fullName: `${body.firstName} ${body.lastName}`,
          username,
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
          customerLabelId: body.customerLabelId,
          customerGroupId: body.customerGroupId,
          gstNumber: body.gstNumber,
          companyName: body.companyName,
          preferredStoreId: body.preferredStoreId,
          sensitivityScore: body.sensitivityScore,
          notes: body.notes,
          defaultDiscountType: body.defaultDiscountType,
          defaultDiscountValue: body.defaultDiscountValue,
        },
        { transaction: tx },
      );

      for (const role of roles) {
        await this.userRolesRepository.create(
          { usersId: user.id, rolesId: role.id },
          { transaction: tx },
        );
      }

      await this.walletService.createWallet(customer.id, { transaction: tx });
      await this.securityDepositService.createDeposit(customer.id, { transaction: tx });

      await tx.commit();

      return {
        message: 'Customer created successfully',
        customer: { ...customer, user: { ...user, password: undefined } },
        assignedRoles: body.roleValues,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
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
          relation: 'customerLabel',
          scope: {
            fields: { id: true, name: true },
          },
        }
      ],
    });
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
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
      ],
    });

    const [wallet, securityDeposit] = await Promise.all([
      this.walletRepository.findOne({ where: { customerId: id } }),
      this.customerSecurityDepositRepository.findOne({ where: { customerId: id } }),
    ]);

    return { ...customer, wallet, securityDeposit };
  }

  @authenticate('jwt')
  @authorize({ roles: ['super_admin'] })
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
              customerLabelId: { type: 'string', format: 'uuid' },
              customerGroupId: { type: 'string', format: 'uuid' },
              gstNumber: { type: 'string' },
              companyName: { type: 'string' },
              loyaltyPoints: { type: 'number' },
              defaultDiscountType: { type: 'string' },
              defaultDiscountValue: { type: 'number' },
              preferredStoreId: { type: 'string', format: 'uuid' },
              sensitivityScore: { type: 'number' },
              notes: { type: 'string' },
              statusChangeRemark: { type: 'string' },
              // role management
              roleValues: { type: 'array', items: { type: 'string' } },
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
      customerLabelId?: string;
      customerGroupId?: string;
      gstNumber?: string;
      companyName?: string;
      loyaltyPoints?: number;
      defaultDiscountType?: string;
      defaultDiscountValue?: number;
      preferredStoreId?: string;
      sensitivityScore?: number;
      notes?: string;
      statusChangeRemark?: string;
      roleValues?: string[];
    },
  ): Promise<void> {
    const customer = await this.customerRepository.findById(id);

    const { roleValues, ...rest } = body;

    const userFields: Record<string, unknown> = {};
    const customerFields: Record<string, unknown> = {};

    const userKeys = ['fullName', 'email', 'countryCode', 'phone', 'isActive'];
    const customerKeys = [
      'firstName', 'lastName', 'customerEntityType', 'customerLabelId', 'customerGroupId',
      'gstNumber', 'companyName', 'loyaltyPoints', 'defaultDiscountType',
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

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      if (Object.keys(userFields).length > 0) {
        await this.usersRepository.updateById(customer.userId, userFields, { transaction: tx });
      }

      if (Object.keys(customerFields).length > 0) {
        await this.customerRepository.updateById(id, customerFields, { transaction: tx });
      }

      if (roleValues?.length) {
        const roles = await Promise.all(
          roleValues.map(async v => {
            const role = await this.rolesRepository.findOne({ where: { value: v } });
            if (!role) throw new HttpErrors.BadRequest(`Role not found: ${v}`);
            return role;
          }),
        );
        await this.userRolesRepository.deleteAll(
          { usersId: customer.userId },
          { transaction: tx },
        );
        for (const role of roles) {
          await this.userRolesRepository.create(
            { usersId: customer.userId, rolesId: role.id },
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
