import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
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
import {securityId, UserProfile} from '@loopback/security';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerRepository,
} from '../repositories';

export class CustomerFamilyGroupController {
  constructor(
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(CustomerFamilyGroupRepository)
    private groupRepository: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository)
    private memberRepository: CustomerFamilyGroupMemberRepository,
  ) {}

  private async resolveCustomerId(userId: string): Promise<string> {
    const customer = await this.customerRepository.findOne({
      where: {userId, isDeleted: false},
    });
    if (!customer) throw new HttpErrors.NotFound('Customer profile not found.');
    return customer.id;
  }

  /**
   * The group this customer OWNS. Used by every write path — only the primary
   * customer may rename the group or add/edit/remove members.
   */
  private async resolveGroup(primaryCustomerId: string) {
    const group = await this.groupRepository.findOne({
      where: {primaryCustomerId, isDeleted: false},
    });
    if (!group) throw new HttpErrors.NotFound('Family group not found. Create one first.');
    return group;
  }

  /**
   * The group this customer can SEE — the one they own, or failing that the one
   * they were added to as a member. Members get read access so they can tell
   * which family they belong to; they still cannot modify it.
   */
  private async resolveVisibleGroup(customerId: string) {
    const owned = await this.groupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    if (owned) return {group: owned, role: 'primary' as const, membership: null};

    const membership = await this.memberRepository.findOne({
      where: {customerId, isDeleted: false},
      order: ['createdAt ASC'],
    });
    if (membership?.groupId) {
      const group = await this.groupRepository.findOne({
        where: {id: membership.groupId, isDeleted: false},
      });
      if (group) return {group, role: 'member' as const, membership};
    }

    throw new HttpErrors.NotFound('You do not belong to any family group yet.');
  }

  /**
   * A customer belongs to exactly ONE family group — either as its primary or as
   * a member of someone else's, never both and never several. Throws if the
   * customer is already in a group.
   *
   * `ignoreMemberId` lets an existing member row re-save without tripping on itself.
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

  /** Name of the customer who owns the group, so a member knows whose it is. */
  private async describePrimary(primaryCustomerId?: string) {
    if (!primaryCustomerId) return null;
    const c = await this.customerRepository.findOne({
      where: {id: primaryCustomerId, isDeleted: false},
      fields: {id: true, firstName: true, lastName: true, customerCode: true},
    });
    if (!c) return null;
    return {
      id: c.id,
      name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
      customerCode: c.customerCode,
    };
  }

  // ─── Group ────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/customer/family-group')
  @response(200, {description: 'Create family group'})
  async createGroup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const primaryCustomerId = await this.resolveCustomerId(currentUser[securityId]);

    const existing = await this.groupRepository.findOne({
      where: {primaryCustomerId, isDeleted: false},
    });

    if (existing) {
      throw new HttpErrors.Conflict('You already have a family group.');
    }

    // One group per customer: already being someone else's member blocks this too.
    const existingMembership = await this.memberRepository.findOne({
      where: {customerId: primaryCustomerId, isDeleted: false},
    });
    if (existingMembership) {
      throw new HttpErrors.Conflict(
        'You already belong to a family group. Leave it before creating your own.',
      );
    }

    const group = await this.groupRepository.create({primaryCustomerId, name: body.name});
    return {message: 'Family group created.', group};
  }

  @authenticate('jwt')
  @get('/profile/customer/family-group')
  @response(200, {description: 'Get my family group with members'})
  async getGroup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    // Works for the owner AND for someone who was added as a member.
    const {group, role, membership} = await this.resolveVisibleGroup(customerId);
    const members = await this.memberRepository.find({
      where: {groupId: group.id, isDeleted: false},
    });
    return {
      ...group,
      role, // 'primary' = you own it, 'member' = you were added to it
      canManage: role === 'primary',
      primaryCustomer: await this.describePrimary(group.primaryCustomerId),
      myMemberId: membership?.id ?? null,
      members,
    };
  }

  @authenticate('jwt')
  @patch('/profile/customer/family-group')
  @response(200, {description: 'Update family group name'})
  async updateGroup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const primaryCustomerId = await this.resolveCustomerId(currentUser[securityId]);
    const group = await this.resolveGroup(primaryCustomerId);
    await this.groupRepository.updateById(group.id, {name: body.name});
    return {message: 'Family group updated.'};
  }

  // ─── Members ──────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/customer/family-group/members')
  @response(200, {description: 'Add a family member'})
  async addMember(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
              customerId: {type: 'string', format: 'uuid', description: 'Link to an existing customer account'},
            },
          },
        },
      },
    })
    body: {name: string; phone?: string; relationship: ContactRelationship; customerId?: string},
  ): Promise<object> {
    const primaryCustomerId = await this.resolveCustomerId(currentUser[securityId]);
    const group = await this.resolveGroup(primaryCustomerId);

    if (body.customerId) {
      const linkedCustomer = await this.customerRepository.findOne({
        where: {id: body.customerId, isDeleted: false},
      });
      if (!linkedCustomer) {
        throw new HttpErrors.NotFound('The linked customer account does not exist.');
      }
      // Prevent adding yourself
      if (body.customerId === primaryCustomerId) {
        throw new HttpErrors.BadRequest('You cannot add yourself as a family member.');
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
  @get('/profile/customer/family-group/members')
  @response(200, {description: 'List family members'})
  async listMembers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    // Readable by the owner and by any member of the group.
    const {group, role} = await this.resolveVisibleGroup(customerId);
    const members = await this.memberRepository.find({
      where: {groupId: group.id, isDeleted: false},
    });
    return {members, role, canManage: role === 'primary'};
  }

  @authenticate('jwt')
  @patch('/profile/customer/family-group/members/{memberId}')
  @response(200, {description: 'Update a family member'})
  async updateMember(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const primaryCustomerId = await this.resolveCustomerId(currentUser[securityId]);
    const group = await this.resolveGroup(primaryCustomerId);

    const member = await this.memberRepository.findById(memberId);
    if (member.groupId !== group.id || member.isDeleted) {
      throw new HttpErrors.Forbidden('You do not have permission to update this member.');
    }

    // Linking this member row to a customer account: that customer must be free.
    if (body.customerId && body.customerId !== member.customerId) {
      if (body.customerId === primaryCustomerId) {
        throw new HttpErrors.BadRequest('You cannot add yourself as a family member.');
      }
      await this.assertNotInAnyGroup(body.customerId, memberId);
    }

    await this.memberRepository.updateById(memberId, body);
    return {message: 'Family member updated.'};
  }

  @authenticate('jwt')
  @del('/profile/customer/family-group/members/{memberId}')
  @response(200, {description: 'Remove a family member'})
  async removeMember(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('memberId') memberId: string,
  ): Promise<object> {
    const primaryCustomerId = await this.resolveCustomerId(currentUser[securityId]);
    const group = await this.resolveGroup(primaryCustomerId);

    const member = await this.memberRepository.findById(memberId);
    if (member.groupId !== group.id || member.isDeleted) {
      throw new HttpErrors.Forbidden('You do not have permission to remove this member.');
    }

    await this.memberRepository.updateById(memberId, {
      isDeleted: true,
      isActive: false,
      deletedAt: new Date() as unknown as Date,
    });

    return {message: 'Family member removed.'};
  }
}
