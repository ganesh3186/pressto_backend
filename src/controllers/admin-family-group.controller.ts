import {authenticate} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {
  del,
  get,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerLabelAssignmentRepository,
  CustomerRepository,
  RolesRepository,
  UserRolesRepository,
  UsersRepository,
} from '../repositories';
import {BcryptHasher} from '../services/hash.password.bcrypt';
import {SecurityDepositService} from '../services/security-deposit.service';
import {WalletService} from '../services/wallet.service';

/** Role a family member's login is created under, in order of preference. */
const CUSTOMER_ROLE_VALUES = ['customer', 'client'];

/** Same starter password the full customer form uses. */
const DEFAULT_MEMBER_PASSWORD = 'Pressto@1234';

export class AdminFamilyGroupController {
  constructor(
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(CustomerFamilyGroupRepository)
    private groupRepository: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository)
    private memberRepository: CustomerFamilyGroupMemberRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @repository(CustomerLabelAssignmentRepository)
    private customerLabelAssignmentRepository: CustomerLabelAssignmentRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
  ) {}

  /** The group this customer OWNS — required for every write path. */
  private async resolveGroup(primaryCustomerId: string) {
    const group = await this.groupRepository.findOne({
      where: {primaryCustomerId, isDeleted: false},
    });
    if (!group) throw new HttpErrors.NotFound('This customer does not have a family group.');
    return group;
  }

  /**
   * The group this customer is IN — the one they own, or the one they were added
   * to as a member. Lets staff look up any customer's family, not just owners.
   */
  private async resolveVisibleGroup(customerId: string) {
    const owned = await this.groupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    if (owned) return {group: owned, role: 'primary' as const};

    const membership = await this.memberRepository.findOne({
      where: {customerId, isDeleted: false},
      order: ['createdAt ASC'],
    });
    if (membership?.groupId) {
      const group = await this.groupRepository.findOne({
        where: {id: membership.groupId, isDeleted: false},
      });
      if (group) return {group, role: 'member' as const};
    }

    throw new HttpErrors.NotFound('This customer does not belong to a family group.');
  }

  /**
   * A customer belongs to exactly ONE family group — as its primary or as a
   * member of someone else's, never both and never several.
   */
  private async assertNotInAnyGroup(customerId: string, ignoreMemberId?: string) {
    const owned = await this.groupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    if (owned) {
      throw new HttpErrors.Conflict('That customer already has their own family group.');
    }
    const membership = await this.memberRepository.findOne({
      where: {customerId, isDeleted: false},
    });
    if (membership && membership.id !== ignoreMemberId) {
      throw new HttpErrors.Conflict('That customer already belongs to another family group.');
    }
  }

  /** The role every customer login carries — mirrors CustomerController. */
  private async resolveCustomerRole() {
    for (const value of CUSTOMER_ROLE_VALUES) {
      const role = await this.rolesRepository.findOne({where: {value}});
      if (role) return role;
    }
    throw new HttpErrors.BadRequest(
      'Customer role not found. Add a role with value "customer" in Role Master, then try again.',
    );
  }

  private async generateUniqueUsername(email: string, fullName: string): Promise<string> {
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
    const last = await this.customerRepository.findOne({
      order: ['createdAt DESC'],
      fields: {customerCode: true},
    });
    if (!last?.customerCode) return 'CUST0001';
    const numPart = parseInt(last.customerCode.replace('CUST', ''), 10);
    return `CUST${String((isNaN(numPart) ? 0 : numPart) + 1).padStart(4, '0')}`;
  }

  /** Owner of the group, so the UI can list them alongside the members. */
  private async describePrimary(primaryCustomerId?: string) {
    if (!primaryCustomerId) return null;
    const c = await this.customerRepository.findOne({
      where: {id: primaryCustomerId, isDeleted: false},
    });
    if (!c) return null;
    const user = c.userId
      ? await this.usersRepository.findOne({where: {id: c.userId}})
      : null;
    return {
      id: c.id,
      name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
      customerCode: c.customerCode,
      phone: user?.phone ?? null,
      countryCode: user?.countryCode ?? null,
      email: c.email ?? user?.email ?? null,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:read']})
  @get('/admin/customers/{customerId}/family-group')
  @response(200, {description: 'Get customer family group with members'})
  async getGroup(
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    // Resolves whether this customer owns the group or is a member of it.
    const {group, role} = await this.resolveVisibleGroup(customerId);
    const members = await this.memberRepository.find({
      where: {groupId: group.id, isDeleted: false},
    });
    return {
      ...group,
      role, // 'primary' = this customer owns the group, 'member' = added to it
      canManage: role === 'primary', // only the primary may add/edit/remove
      primaryCustomer: await this.describePrimary(group.primaryCustomerId),
      members,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:create']})
  @post('/admin/customers/{customerId}/family-group')
  @response(200, {description: 'Create family group for a customer'})
  async createGroup(
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: {type: 'string'},
            },
          },
        },
      },
    })
    body: {name?: string},
  ): Promise<object> {
    const customer = await this.customerRepository.findOne({
      where: {id: customerId, isDeleted: false},
    });
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    const existing = await this.groupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    if (existing) throw new HttpErrors.Conflict('Customer already has a family group.');

    // One group per customer: being someone else's member blocks this too.
    const existingMembership = await this.memberRepository.findOne({
      where: {customerId, isDeleted: false},
    });
    if (existingMembership) {
      throw new HttpErrors.Conflict(
        'Customer already belongs to another family group. Remove them from it first.',
      );
    }

    const group = await this.groupRepository.create({
      primaryCustomerId: customerId,
      name: body.name,
    });
    return {message: 'Family group created.', group};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:create']})
  @post('/admin/customers/{customerId}/family-group/members')
  @response(200, {description: 'Add a family member for a customer'})
  async addMember(
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'relationship'],
            properties: {
              name: {type: 'string'},
              phone: {type: 'string'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
              customerId: {type: 'string', format: 'uuid'},
            },
          },
        },
      },
    })
    body: {name: string; phone?: string; relationship: ContactRelationship; customerId?: string},
  ): Promise<object> {
    const group = await this.resolveGroup(customerId);

    if (body.customerId) {
      const linked = await this.customerRepository.findOne({
        where: {id: body.customerId, isDeleted: false},
      });
      if (!linked) throw new HttpErrors.NotFound('Linked customer account does not exist.');
      if (body.customerId === customerId) {
        throw new HttpErrors.BadRequest('Cannot add the primary customer as a member.');
      }
      // One group per customer.
      await this.assertNotInAnyGroup(body.customerId);
    }

    const member = await this.memberRepository.create({
      groupId: group.id,
      name: body.name,
      phone: body.phone,
      relationship: body.relationship,
      customerId: body.customerId,
    });

    return {message: 'Family member added.', member};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:create']})
  @post('/admin/customers/{customerId}/family-group/members/new-customer')
  @response(200, {description: 'Create a customer account and add them to the family in one step'})
  async addNewCustomerMember(
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['firstName', 'phone', 'relationship'],
            properties: {
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              countryCode: {type: 'string', default: '+91'},
              phone: {type: 'string'},
              email: {type: 'string', format: 'email'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
            },
          },
        },
      },
    })
    body: {
      firstName: string;
      lastName?: string;
      countryCode?: string;
      phone: string;
      email?: string;
      relationship: ContactRelationship;
    },
  ): Promise<object> {
    const group = await this.resolveGroup(customerId);

    const primary = await this.customerRepository.findOne({
      where: {id: customerId, isDeleted: false},
    });
    if (!primary) throw new HttpErrors.NotFound('Primary customer not found.');

    const firstName = (body.firstName ?? '').trim();
    const lastName = (body.lastName ?? '').trim();
    const phone = (body.phone ?? '').trim();
    const email = (body.email ?? '').trim();
    if (!firstName) throw new HttpErrors.BadRequest('First name is required.');
    if (!phone) throw new HttpErrors.BadRequest('Mobile number is required.');

    // Same uniqueness rule as the full customer form.
    const orConditions: object[] = [{phone}];
    if (email) orConditions.push({email});
    const clash = await this.usersRepository.findOne({where: {or: orConditions}});
    if (clash) {
      throw new HttpErrors.Conflict(
        'A customer with this mobile number or email already exists. Search for them in the list instead.',
      );
    }

    const role = await this.resolveCustomerRole();
    const hashedPassword = await this.hasher.hashPassword(DEFAULT_MEMBER_PASSWORD);
    const fullName = `${firstName} ${lastName}`.trim();
    const username = await this.generateUniqueUsername(email, fullName);
    const customerCode = await this.generateCustomerCode();

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const user = await this.usersRepository.create(
        {
          fullName,
          username,
          ...(email && {email}),
          countryCode: body.countryCode || '+91',
          phone,
          password: hashedPassword,
          isActive: true,
        },
        {transaction: tx},
      );

      // Everything the member isn't asked for is inherited from the primary —
      // same store, same type/label/group, same payment + discount defaults.
      const customer = await this.customerRepository.create(
        {
          userId: user.id,
          customerCode,
          firstName,
          lastName,
          ...(email && {email}),
          customerEntityType: primary.customerEntityType ?? 'individual',
          customerTypeId: primary.customerTypeId,
          customerGroupId: primary.customerGroupId,
          preferredStoreId: primary.preferredStoreId,
          preferredPaymentMode: primary.preferredPaymentMode,
          defaultDiscountType: primary.defaultDiscountType,
          defaultDiscountValue: primary.defaultDiscountValue,
        },
        {transaction: tx},
      );

      await this.userRolesRepository.create(
        {usersId: user.id, rolesId: role.id},
        {transaction: tx},
      );

      // Labels inherit too, same as everything above — copy every label
      // currently on the primary onto the new member.
      const primaryLabels = await this.customerLabelAssignmentRepository.find({
        where: {customerId: primary.id, isDeleted: false},
      });
      for (const label of primaryLabels) {
        await this.customerLabelAssignmentRepository.create(
          {customerId: customer.id, customerLabelId: label.customerLabelId},
          {transaction: tx},
        );
      }

      await this.walletService.createWallet(customer.id, {transaction: tx});
      await this.securityDepositService.createDeposit(customer.id, {transaction: tx});

      const member = await this.memberRepository.create(
        {
          groupId: group.id,
          name: fullName,
          phone,
          relationship: body.relationship,
          customerId: customer.id,
        },
        {transaction: tx},
      );

      await tx.commit();

      return {
        message: 'Customer created and added to the family group.',
        member,
        customer: {...customer, user: {...user, password: undefined}},
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:update']})
  @patch('/admin/customers/{customerId}/family-group/members/{memberId}')
  @response(200, {description: 'Update a family member'})
  async updateMember(
    @param.path.string('customerId') customerId: string,
    @param.path.string('memberId') memberId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: {type: 'string'},
              phone: {type: 'string'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
              customerId: {type: 'string', format: 'uuid'},
            },
          },
        },
      },
    })
    body: {name?: string; phone?: string; relationship?: ContactRelationship; customerId?: string},
  ): Promise<object> {
    const group = await this.resolveGroup(customerId);
    const member = await this.memberRepository.findById(memberId);
    if (member.groupId !== group.id || member.isDeleted) {
      throw new HttpErrors.Forbidden('Member does not belong to this group.');
    }

    // Linking this member row to a customer account: that customer must be free.
    if (body.customerId && body.customerId !== member.customerId) {
      if (body.customerId === customerId) {
        throw new HttpErrors.BadRequest('Cannot add the primary customer as a member.');
      }
      await this.assertNotInAnyGroup(body.customerId, memberId);
    }

    await this.memberRepository.updateById(memberId, body);
    return {message: 'Family member updated.'};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['family_group:delete']})
  @del('/admin/customers/{customerId}/family-group/members/{memberId}')
  @response(200, {description: 'Remove a family member'})
  async removeMember(
    @param.path.string('customerId') customerId: string,
    @param.path.string('memberId') memberId: string,
  ): Promise<object> {
    const group = await this.resolveGroup(customerId);
    const member = await this.memberRepository.findById(memberId);
    if (member.groupId !== group.id || member.isDeleted) {
      throw new HttpErrors.Forbidden('Member does not belong to this group.');
    }
    await this.memberRepository.updateById(memberId, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date() as unknown as Date,
    });
    return {message: 'Family member removed.'};
  }
}
