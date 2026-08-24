import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ContactRelationship} from '../models/contact-relationship.enum';
import {CustomerContact} from '../models';
import {CustomerContactService} from '../services/customer-contact.service';
import {
  CustomerFamilyGroupMemberRepository,
  CustomerFamilyGroupRepository,
  CustomerRepository,
  RiderRepository,
} from '../repositories';

/**
 * Household contacts + family group members, for a rider's own
 * "Deliver to" picker (RiderDeliveryController.deliver's deliverTo,
 * collectorType: contact | family_member) and the pickup handoverBy
 * picker — the same two lists the customer manages themselves via
 * /profile/customer/contacts and /profile/customer/family-group, just
 * rider-scoped by an explicit customerId path param instead of resolved
 * from the caller's own JWT.
 *
 * List-and-add only — riders can't edit/remove a customer's saved
 * contacts or family members, only the customer (or admin) can.
 */
export class RiderCustomerContactsController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @repository(CustomerRepository) private customerRepository: CustomerRepository,
    @repository(CustomerFamilyGroupRepository) private familyGroupRepository: CustomerFamilyGroupRepository,
    @repository(CustomerFamilyGroupMemberRepository)
    private familyMemberRepository: CustomerFamilyGroupMemberRepository,
    @inject('services.customer-contact') private contactService: CustomerContactService,
  ) {}

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  private async assertCustomerExists(customerId: string) {
    const customer = await this.customerRepository.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    return customer;
  }

  // ─── Household contacts ───────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customers/{customerId}/contacts')
  @response(200, {description: "The customer's saved household contacts"})
  async getContacts(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    await this.resolveActiveRider(currentUser);
    await this.assertCustomerExists(customerId);
    const contacts = await this.contactService.findAll(customerId);
    return {contacts};
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/customers/{customerId}/contacts')
  @response(200, {description: 'Household contact added'})
  async addContact(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'phone', 'relationship'],
            properties: {
              name: {type: 'string'},
              phone: {type: 'string'},
              email: {type: 'string', format: 'email'},
              relationship: {type: 'string', enum: Object.values(ContactRelationship)},
              isPrimary: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {name: string; phone: string; relationship: ContactRelationship; email?: string; isPrimary?: boolean},
  ): Promise<object> {
    await this.resolveActiveRider(currentUser);
    await this.assertCustomerExists(customerId);
    const contact: CustomerContact = await this.contactService.create(customerId, body);
    return {message: 'Contact added.', contact};
  }

  // ─── Family group members ─────────────────────────────────────────────────
  // A rider adding the first-ever family member for a customer who's never
  // touched the customer-web app shouldn't hit a "create a group first"
  // wall — find-or-create the group here rather than requiring a separate
  // create-group call, unlike the self-service /profile/customer/family-group
  // flow this mirrors.

  private async findOrCreateGroup(customerId: string) {
    const existing = await this.familyGroupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    if (existing) return existing;
    const {v4} = await import('uuid');
    return this.familyGroupRepository.create({id: v4(), primaryCustomerId: customerId});
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customers/{customerId}/family-members')
  @response(200, {description: "The customer's saved family group members"})
  async getFamilyMembers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
  ): Promise<object> {
    await this.resolveActiveRider(currentUser);
    await this.assertCustomerExists(customerId);
    const group = await this.familyGroupRepository.findOne({
      where: {primaryCustomerId: customerId, isDeleted: false},
    });
    // No group yet reads as "no family members yet", not a 404 — a rider's
    // list view shouldn't have to special-case this.
    if (!group) return {members: []};
    const members = await this.familyMemberRepository.find({
      where: {groupId: group.id, isDeleted: false},
    });
    return {members};
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/customers/{customerId}/family-members')
  @response(200, {description: 'Family member added'})
  async addFamilyMember(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
            },
          },
        },
      },
    })
    body: {name: string; phone?: string; relationship: ContactRelationship},
  ): Promise<object> {
    await this.resolveActiveRider(currentUser);
    await this.assertCustomerExists(customerId);
    const group = await this.findOrCreateGroup(customerId);
    const {v4} = await import('uuid');
    const member = await this.familyMemberRepository.create({
      id: v4(),
      groupId: group.id,
      name: body.name,
      phone: body.phone,
      relationship: body.relationship,
    });
    return {message: 'Family member added.', member};
  }
}
