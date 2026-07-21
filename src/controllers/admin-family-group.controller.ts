import {authenticate} from '@loopback/authentication';
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
import {authorize} from '../authorization';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerRepository,
} from '../repositories';

export class AdminFamilyGroupController {
  constructor(
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(CustomerFamilyGroupRepository)
    private groupRepository: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository)
    private memberRepository: CustomerFamilyGroupMemberRepository,
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
    return {...group, role, members};
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
