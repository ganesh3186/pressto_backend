import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {get, getModelSchemaRef, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {
  ColourBleedingChoice,
  CustomerAddress,
  CustomerPreference,
  CustomerWithRelations,
  ItemCategory,
  PickupDeliverySlot,
  PickupHandoverBy,
  PickupRequest,
  Service,
  ServiceCategory,
  Store,
  UpgradeServiceChoice,
} from '../models';
import {BagStatus} from '../models/bag-status.enum';
import {PickupDeliverySlotType} from '../models/pickup-delivery-slot-type.enum';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {PICKUP_REQUEST_STATUS_TRANSITIONS, PickupRequestStatus} from '../models/pickup-request-status.enum';
import {PickupUnsuccessfulReason} from '../models/pickup-unsuccessful-reason.enum';
import {
  BagRepository,
  CustomerRepository,
  ItemCategoryRepository,
  PickupDeliverySlotRepository,
  PickupEscalationRepository,
  PickupRequestRepository,
  RiderRepository,
  RolesRepository,
  ServiceCategoryRepository,
  ServiceRepository,
  StoreRepository,
  UserRolesRepository,
  UsersRepository,
} from '../repositories';
import {CustomerAddressService} from '../services/customer-address.service';
import {CustomerPreferenceChanges, CustomerPreferenceService} from '../services/customer-preference.service';
import {BcryptHasher} from '../services/hash.password.bcrypt';
import {SecurityDepositService} from '../services/security-deposit.service';
import {WalletService} from '../services/wallet.service';
import {DeliveryGroupingPreference} from '../models/delivery-grouping-preference.enum';
import {DeliveryType} from '../models/delivery-type.enum';
import {filterSlotsForDate} from '../utils/pickup-slot-availability';
import {PROTECTED_ROLES} from '../utils/role-guard';

const RIDER_STATUS_TRANSITIONS: PickupRequestStatus[] = [
  PickupRequestStatus.OUT_FOR_PICKUP,
  PickupRequestStatus.ARRIVED_AT_PICKUP,
  PickupRequestStatus.PICKED_UP,
  PickupRequestStatus.RECEIVED_AT_STORE,
  PickupRequestStatus.PICKUP_UNSUCCESSFUL,
];

/**
 * Rider-facing pickup APIs — the "neighbour also wants a pickup" flow: a
 * rider already on the ground can create a brand-new customer, then a
 * pickup request for them, and either attach it to their current ongoing
 * run (pickupNow) or self-assign a standalone new one. Also covers the
 * rider's own status-transition control over their assigned pickups.
 *
 * Role-gated (roles: ['rider']) like customer self-service, not the admin
 * permission system — see rider-auth.controller.ts's JWT for how a rider's
 * token gets the 'rider' role.
 */
export class RiderPickupController {
  constructor(
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(RolesRepository)
    private rolesRepository: RolesRepository,
    @repository(UserRolesRepository)
    private userRolesRepository: UserRolesRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(PickupDeliverySlotRepository)
    private pickupSlotRepository: PickupDeliverySlotRepository,
    @repository(BagRepository)
    private bagRepository: BagRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
    @repository(ItemCategoryRepository)
    private itemCategoryRepository: ItemCategoryRepository,
    @repository(ServiceCategoryRepository)
    private serviceCategoryRepository: ServiceCategoryRepository,
    @repository(PickupEscalationRepository)
    private pickupEscalationRepository: PickupEscalationRepository,
    @inject('services.customer-address')
    private addressService: CustomerAddressService,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
    @inject('services.customer-preference')
    private preferenceService: CustomerPreferenceService,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
  ) {}

  // ─── Identity ─────────────────────────────────────────────────────────────

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  // Same checks as TransferController.assertBagAvailable (transfer.controller.ts)
  // — exists, active, not already locked to another custody chain.
  private async assertBagAvailable(bagId: string) {
    const bag = await this.bagRepository.findOne({where: {id: bagId, isDeleted: false}});
    if (!bag) throw new HttpErrors.NotFound('Bag not found.');
    if (!bag.isActive) throw new HttpErrors.BadRequest('This bag is inactive.');
    if (bag.status !== BagStatus.AVAILABLE) {
      throw new HttpErrors.Conflict(
        `Bag ${bag.bagNumber} is already ${bag.status === BagStatus.FULL ? 'full' : 'in use'}.`,
      );
    }
    return bag;
  }

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
    if (!lastCustomer?.customerCode) return 'CUST0001';
    const numPart = parseInt(lastCustomer.customerCode.replace('CUST', ''), 10);
    const nextNum = (isNaN(numPart) ? 0 : numPart) + 1;
    return `CUST${String(nextNum).padStart(4, '0')}`;
  }

  private async resolveCustomerRole() {
    const existing = await this.rolesRepository.findOne({where: {value: 'customer'}});
    if (existing) return existing;
    return this.rolesRepository.create({
      value: 'customer',
      label: 'Customer',
      description: 'Customer web/app account — own profile, orders and wallet.',
      isLocked: true,
      loginAccess: true,
      scope: 'store',
      isActive: true,
      isDeleted: false,
    });
  }

  // ─── Create a walk-in customer ──────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/customers')
  @response(200, {description: 'Customer created'})
  async createCustomer(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['firstName', 'lastName', 'phone'],
            properties: {
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              email: {type: 'string', format: 'email'},
              phone: {type: 'string'},
              countryCode: {type: 'string', default: '+91'},
            },
          },
        },
      },
    })
    body: {firstName: string; lastName: string; email?: string; phone: string; countryCode?: string},
  ): Promise<object> {
    const orConditions: object[] = [{phone: body.phone}];
    if (body.email) orConditions.push({email: body.email});
    const existingUser = await this.usersRepository.findOne({
      where: {or: orConditions},
      include: [{relation: 'roles'}],
    });

    if (existingUser) {
      const existingRoleValues = (existingUser.roles ?? []).map(r => r.value);
      if (PROTECTED_ROLES.some(r => existingRoleValues.includes(r))) {
        throw new HttpErrors.Conflict('That phone or email belongs to a protected system account.');
      }
      const alreadyCustomer = await this.customerRepository.findOne({
        where: {userId: existingUser.id, isDeleted: false},
      });
      if (alreadyCustomer) {
        throw new HttpErrors.Conflict(
          `That phone or email already belongs to customer ${alreadyCustomer.customerCode} — search for them instead of creating a new one.`,
        );
      }
      // An existing non-customer login (e.g. staff) needs an explicit
      // confirm-and-link step the rider app has no UI for — out of scope
      // here, matches the admin/self-registration flows' own guard posture.
      throw new HttpErrors.Conflict(
        'That phone or email is already linked to another account. Ask the store to add this customer instead.',
      );
    }

    const customerRole = await this.resolveCustomerRole();
    const customerCode = await this.generateCustomerCode();
    const fullName = `${body.firstName} ${body.lastName}`;

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const user = await this.usersRepository.create(
        {
          fullName,
          username: await this.generateUniqueUsername(body.email, fullName),
          ...(body.email && {email: body.email}),
          countryCode: body.countryCode?.trim() ? body.countryCode.trim() : '+91',
          phone: body.phone,
          password: await this.hasher.hashPassword('Pressto@1234'),
          isActive: true,
        },
        {transaction: tx},
      );

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

      await this.userRolesRepository.create(
        {usersId: user.id, rolesId: customerRole.id},
        {transaction: tx},
      );
      await this.walletService.createWallet(customer.id, {transaction: tx});
      await this.securityDepositService.createDeposit(customer.id, {transaction: tx});

      await tx.commit();
      return {message: 'Customer created.', customer};
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Search existing customers ──────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customers')
  @response(200, {description: 'Customers matching name/phone search'})
  async searchCustomers(@param.query.string('search') search?: string): Promise<object[]> {
    if (!search?.trim()) return [];
    const term = search.trim();

    // Phone lives on Users, not Customer — resolve matching users first,
    // same two-step pattern OrderService.listOrders() already uses for
    // name-or-phone search, then OR their customerIds into the main query.
    const phoneMatchedUsers = await this.usersRepository.find({
      where: {phone: {ilike: `%${term}%`}, isDeleted: false} as object,
      fields: {id: true} as object,
    });
    const phoneMatchedUserIds = phoneMatchedUsers.map(u => u.id);

    return this.customerRepository.find({
      where: {
        isDeleted: false,
        or: [
          {firstName: {ilike: `%${term}%`}},
          {lastName: {ilike: `%${term}%`}},
          {email: {ilike: `%${term}%`}},
          ...(phoneMatchedUserIds.length ? [{userId: {inq: phoneMatchedUserIds}}] : []),
        ],
      } as object,
      include: [{relation: 'user', scope: {fields: {id: true, phone: true, countryCode: true}}}],
      limit: 20,
    });
  }

  // ─── Customer addresses ─────────────────────────────────────────────────────
  //
  // Riders can already pass a saved addressId or free inline text when
  // creating a pickup request (see createPickupRequest below). These three
  // let the rider app actually resolve a saved address to offer as a
  // picklist, look one up on its own, and — for a brand-new customer —
  // save a real, reusable CustomerAddress instead of only ever sending
  // inline text for this one pickup. Same CustomerAddressService the admin
  // panel and customer app use; just exposed under the rider role instead
  // of the admin permission system.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customers/{customerId}/addresses')
  @response(200, {
    description: "A customer's saved addresses",
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(CustomerAddress)}}},
  })
  async getCustomerAddresses(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
  ): Promise<CustomerAddress[]> {
    await this.resolveActiveRider(currentUser);
    const customer = await this.customerRepository.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    return this.addressService.findAll(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customer-addresses/{id}')
  @response(200, {
    description: 'A single saved address',
    content: {'application/json': {schema: getModelSchemaRef(CustomerAddress)}},
  })
  async getCustomerAddressById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<CustomerAddress> {
    await this.resolveActiveRider(currentUser);
    return this.addressService.findById(id);
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/customers/{customerId}/addresses')
  @response(200, {
    description: 'Address saved for this customer',
    content: {'application/json': {schema: getModelSchemaRef(CustomerAddress)}},
  })
  async createCustomerAddress(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['addressLine1', 'city', 'state', 'pincode'],
            properties: {
              addressType: {type: 'string'},
              addressName: {type: 'string', description: "e.g. Father's home, 2nd office"},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              doorFloorFlat: {type: 'string'},
              societyName: {type: 'string'},
              landmark: {type: 'string'},
              city: {type: 'string'},
              state: {type: 'string'},
              country: {type: 'string'},
              pincode: {type: 'string'},
              latitude: {type: 'number'},
              longitude: {type: 'number'},
              isDefault: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Partial<CustomerAddress>,
  ): Promise<CustomerAddress> {
    await this.resolveActiveRider(currentUser);
    const customer = await this.customerRepository.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    return this.addressService.create(customerId, body);
  }

  // ─── Customer preferences ────────────────────────────────────────────────────
  // Mirrors customer-profile.controller.ts's own GET/PATCH /profile/customer/
  // preferences exactly, reusing the same CustomerPreferenceService — this is
  // how the "Do this for all my orders" + auto-approval toggles sheet in the
  // rider app's Place Order flow gets saved on a customer's behalf. changedBy
  // is the RIDER's own user id (not the customer's), so the audit trail
  // honestly records who actually made the change.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/customers/{customerId}/preferences')
  @response(200, {
    description: "A customer's stored preferences (created with defaults on first read)",
    content: {'application/json': {schema: getModelSchemaRef(CustomerPreference)}},
  })
  async getCustomerPreferences(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
  ): Promise<CustomerPreference> {
    await this.resolveActiveRider(currentUser);
    const customer = await this.customerRepository.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    return this.preferenceService.getOrCreate(customerId);
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @patch('/rider/customers/{customerId}/preferences')
  @response(200, {
    description: 'Updated preferences',
    content: {'application/json': {schema: getModelSchemaRef(CustomerPreference)}},
  })
  async updateCustomerPreferences(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              applyInstructionsToAllOrders: {type: 'boolean'},
              specialInstructions: {type: 'string'},
              specialInstructionMediaIds: {type: 'array', items: {type: 'string'}},
              stainAutoApprove: {type: 'boolean'},
              damageAutoApprove: {type: 'boolean'},
              colourBleedingChoice: {type: 'string', enum: Object.values(ColourBleedingChoice)},
              upgradeServiceChoice: {type: 'string', enum: Object.values(UpgradeServiceChoice)},
            },
          },
        },
      },
    })
    body: CustomerPreferenceChanges,
  ): Promise<CustomerPreference> {
    await this.resolveActiveRider(currentUser);
    const customer = await this.customerRepository.findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    return this.preferenceService.update(customerId, body, currentUser[securityId]);
  }

  // ─── Master data (dropdowns for the pickup-request form) ────────────────────
  // itemCategoryEstimate[].itemCategoryId / .serviceId and the top-level
  // storeId (pickupNow=false) all need a picker — these mirror the admin
  // panel's GET /item-categories, /services, /stores, just explicitly
  // rider-scoped like the rest of this controller.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/item-categories')
  @response(200, {
    description: 'Active item categories, for the pickup-request itemCategoryEstimate picker',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(ItemCategory)}}},
  })
  async getItemCategories(): Promise<ItemCategory[]> {
    return this.itemCategoryRepository.find({
      where: {isActive: true, isDeleted: false} as object,
      order: ['sequence ASC', 'name ASC'],
    });
  }

  // Some pickup requests store a ServiceCategory id under
  // itemCategoryEstimate[].itemCategoryId instead of a real ItemCategory id
  // (the admin panel's own "item category" picker actually selects a
  // service category) — resolve against this list when a lookup against
  // GET /rider/item-categories above comes up empty.
  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/service-categories')
  @response(200, {
    description: 'Active service categories — fallback resolver for itemCategoryEstimate.itemCategoryId when it isn\'t a real item category id',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(ServiceCategory)}}},
  })
  async getServiceCategories(): Promise<ServiceCategory[]> {
    return this.serviceCategoryRepository.find({
      where: {isActive: true, isDeleted: false} as object,
      order: ['name ASC'],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/services')
  @response(200, {
    description:
      'Active, independent services with their own process — for the pickup-request ' +
      'itemCategoryEstimate picker. Excludes dependent add-on services (e.g. Presstoke, ' +
      'Repair) that only do real work when attached to another service, since a pickup ' +
      'estimate is standalone and has nothing for those to attach to.',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(Service)}}},
  })
  async getServices(): Promise<Service[]> {
    return this.serviceRepository.find({
      where: {isActive: true, isDeleted: false, dependencyType: 'independent', hasOwnProcess: true} as object,
      order: ['sequence ASC', 'name ASC'],
    });
  }

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/stores')
  @response(200, {
    description: 'Active stores, for the pickup-request storeId picker',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(Store)}}},
  })
  async getStores(): Promise<Store[]> {
    return this.storeRepository.find({
      where: {isActive: true, isDeleted: false} as object,
      order: ['name ASC'],
    });
  }

  // ─── Pickup / delivery slots ─────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-slots')
  @response(200, {
    description: 'Active pickup/delivery slots',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(PickupDeliverySlot)}}},
  })
  async getPickupSlots(
    @param.query.string('type') type?: PickupDeliverySlotType,
    @param.query.string('date') date?: string,
  ): Promise<PickupDeliverySlot[]> {
    const slots = await this.pickupSlotRepository.find({
      where: {
        isActive: true,
        isDeleted: false,
        ...(type ? {type: {inq: [type, PickupDeliverySlotType.BOTH]}} : {}),
      } as object,
      order: ['sortOrder ASC', 'startTime ASC'],
    });
    return filterSlotsForDate(slots, date);
  }

  // ─── The rider's own assigned pickups ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-requests')
  @response(200, {description: "The calling rider's own pickup requests"})
  async myPickupRequests(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    // Exact status, when a caller wants one specific bucket by name (e.g.
    // a future "Cancelled" view) — takes priority over tab when both are
    // sent, though callers should only ever send one.
    @param.query.string('status') status?: PickupRequestStatus,
    // The app's two tabs, as buckets of statuses rather than one exact
    // value — Pending: assigned but not yet picked up. Completed: the
    // rider's own part is done, regardless of whether the store has
    // confirmed receipt yet. Omitting both (or tab=pending) is Pending —
    // the original default, kept so existing callers don't need to change.
    @param.query.string('tab') tab?: 'pending' | 'completed',
  ): Promise<PickupRequest[]> {
    const rider = await this.resolveActiveRider(currentUser);

    let statusWhere: object;
    if (status) {
      statusWhere = {status};
    } else if (tab === 'completed') {
      statusWhere = {status: {inq: [PickupRequestStatus.PICKED_UP, PickupRequestStatus.RECEIVED_AT_STORE]}};
    } else {
      statusWhere = {
        status: {
          inq: [
            PickupRequestStatus.RIDER_ASSIGNED,
            PickupRequestStatus.OUT_FOR_PICKUP,
            PickupRequestStatus.ARRIVED_AT_PICKUP,
            // Still needs the rider's attention — reprocess or give up —
            // so it belongs in the working list, not off to the side.
            PickupRequestStatus.PICKUP_UNSUCCESSFUL,
          ],
        },
      };
    }

    return this.pickupRequestRepository.find({
      where: {
        assignedRiderId: rider.id,
        isDeleted: false,
        ...statusWhere,
      } as object,
      order: ['assignedAt DESC'],
    });
  }

  // ─── Create a walk-in pickup request ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/pickup-requests')
  @response(200, {description: 'Walk-in pickup request created'})
  async createPickupRequest(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerId', 'slotId', 'requestedDate', 'pickupNow'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              addressId: {
                type: 'string',
                format: 'uuid',
                description: "One of the customer's saved addresses.",
              },
              address: {
                type: 'string',
                description: 'Inline address text — for a brand-new customer with nothing saved yet.',
              },
              slotId: {type: 'string', format: 'uuid'},
              requestedDate: {type: 'string', format: 'date'},
              handoverBy: {type: 'string', enum: Object.values(PickupHandoverBy)},
              handoverPersonName: {type: 'string'},
              itemCountEstimate: {type: 'number'},
              itemCategoryEstimate: {
                type: 'array',
                items: {
                  type: 'object',
                  // itemCategoryId is optional for now — the app can send a
                  // bare quantity estimate before its category picker
                  // (GET /rider/item-categories) is wired up.
                  required: ['quantity'],
                  properties: {
                    itemCategoryId: {type: 'string', format: 'uuid'},
                    quantity: {type: 'number'},
                    serviceId: {type: 'string', format: 'uuid'},
                    deliverySpeed: {type: 'string', enum: Object.values(DeliveryType)},
                  },
                },
                description: 'Per-category counts, plus estimate metadata for the store exec — service and delivery-speed preference are not binding, the real order is built after in-store inspection.',
              },
              deliveryGroupingPreference: {
                type: 'string',
                enum: Object.values(DeliveryGroupingPreference),
                description: 'Estimate metadata for the store exec — deliver everything together vs as-and-when-ready.',
              },
              remarks: {
                type: 'string',
                description: 'Free-text special instructions for this pickup.',
              },
              mediaIds: {
                type: 'array',
                items: {type: 'string'},
                description: 'IDs returned by POST /files for any photos/voice notes attached to this pickup.',
              },
              pickupNow: {
                type: 'boolean',
                description:
                  'true: attach to the rider\'s current out_for_pickup run, if they have one. ' +
                  'If not, falls back to creating a standalone new run instead (same as false) ' +
                  '— storeId becomes required either way in that case. ' +
                  'false: always create a standalone new run — storeId is required.',
              },
              storeId: {
                type: 'string',
                format: 'uuid',
                description:
                  'Required when pickupNow is false, or when pickupNow is true but the rider ' +
                  'has no active run to attach to — nothing to inherit it from either way.',
              },
            },
          },
        },
      },
    })
    body: {
      customerId: string;
      addressId?: string;
      address?: string;
      slotId: string;
      requestedDate: string;
      handoverBy?: PickupHandoverBy;
      handoverPersonName?: string;
      itemCountEstimate?: number;
      itemCategoryEstimate?: Array<{
        itemCategoryId?: string;
        quantity: number;
        serviceId?: string;
        deliverySpeed?: DeliveryType;
      }>;
      deliveryGroupingPreference?: DeliveryGroupingPreference;
      remarks?: string;
      mediaIds?: string[];
      pickupNow: boolean;
      storeId?: string;
    },
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);

    const customer: CustomerWithRelations | null = await this.customerRepository.findOne({
      where: {id: body.customerId, isDeleted: false},
      include: [{relation: 'user', scope: {fields: {id: true, phone: true, countryCode: true}}}],
    });
    if (!customer) throw new HttpErrors.NotFound('Customer not found.');

    let addressText: string;
    let pincode: string | undefined;
    if (body.addressId) {
      const address = await this.addressService.findById(body.addressId);
      if (address.customerId !== customer.id) {
        throw new HttpErrors.BadRequest('That address does not belong to this customer.');
      }
      addressText = this.addressService.toDisplaySnapshot(address);
      pincode = address.pincode;
    } else if (body.address?.trim()) {
      addressText = body.address.trim();
    } else {
      throw new HttpErrors.BadRequest('Provide either addressId or address.');
    }

    const slot = await this.pickupSlotRepository.findOne({
      where: {id: body.slotId, isActive: true, isDeleted: false} as object,
    });
    if (!slot) throw new HttpErrors.BadRequest('Pickup slot not found or inactive.');

    if (body.handoverBy && body.handoverBy !== PickupHandoverBy.SELF && !body.handoverPersonName?.trim()) {
      throw new HttpErrors.BadRequest('handoverPersonName is required unless handoverBy is "self".');
    }

    // "Apply to all orders" fallback — per field independently, same as
    // the customer-facing endpoint. An explicit value in the request body
    // always wins; the stored default only fills in a field left out.
    let remarks = body.remarks;
    let mediaIds = body.mediaIds;
    if (remarks === undefined || mediaIds === undefined) {
      const prefs = await this.preferenceService.getOrCreate(customer.id);
      if (prefs.applyInstructionsToAllOrders) {
        if (remarks === undefined) remarks = prefs.specialInstructions;
        if (mediaIds === undefined) mediaIds = prefs.specialInstructionMediaIds;
      }
    }

    const {v4} = await import('uuid');
    const now = new Date();
    const count = await this.pickupRequestRepository.count();
    const pickupNumber = `PU${String(count.count + 1).padStart(6, '0')}`;

    const base = {
      id: v4(),
      pickupNumber,
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerCountryCode: customer.user?.countryCode ?? '+91',
      customerMobile: customer.user?.phone ?? '',
      address: addressText,
      pincode,
      requestedDate: body.requestedDate,
      slot: slot.label,
      pickupSlotId: slot.id,
      source: PickupRequestSource.WEB,
      handoverBy: body.handoverBy,
      handoverPersonName: body.handoverBy === PickupHandoverBy.SELF ? undefined : body.handoverPersonName,
      itemCountEstimate: body.itemCountEstimate,
      itemCategoryEstimate: body.itemCategoryEstimate,
      deliveryGroupingPreference: body.deliveryGroupingPreference,
      remarks,
      mediaIds,
      assignedRiderId: rider.id,
      assignedAt: now,
      assignedBy: currentUser[securityId],
    };

    if (body.pickupNow) {
      const currentRun = await this.pickupRequestRepository.findOne({
        where: {
          assignedRiderId: rider.id,
          status: PickupRequestStatus.OUT_FOR_PICKUP,
          isDeleted: false,
        } as object,
        order: ['assignedAt DESC'],
      });
      if (currentRun) {
        const pickupRequest = await this.pickupRequestRepository.create({
          ...base,
          storeId: currentRun.storeId,
          runId: currentRun.runId,
          status: PickupRequestStatus.OUT_FOR_PICKUP,
        });
        return {message: 'Pickup request created and attached to the current run.', pickupRequest};
      }
      // No active run to attach to — fall through to the standalone path
      // below instead of blocking the rider outright; they just need to
      // send storeId too, same as an explicit pickupNow:false.
    }

    if (!body.storeId) {
      throw new HttpErrors.BadRequest(
        'storeId is required when pickupNow is false, or when pickupNow is true but there is no active run to attach to.',
      );
    }
    const store = await this.storeRepository.findOne({where: {id: body.storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const pickupRequest = await this.pickupRequestRepository.create({
      ...base,
      storeId: body.storeId,
      runId: v4(),
      status: PickupRequestStatus.RIDER_ASSIGNED,
    });
    return {message: 'Pickup request created.', pickupRequest};
  }

  // ─── Bag lookup (scan a real bag before confirming pickup) ─────────────────
  // Must be declared before /rider/bags/{id}-style paths if any get added
  // later — same "static path first" note as garment lookup.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/bags/lookup')
  @response(200, {description: 'Bag details by bag number or UUID — used to confirm a scan before pickup'})
  async lookupBag(
    @param.query.string('q') q: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    await this.resolveActiveRider(currentUser);
    if (!q?.trim()) throw new HttpErrors.BadRequest('Query param "q" is required.');

    const trimmed = q.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(trimmed);

    const bag = isUuid
      ? await this.bagRepository.findOne({where: {id: trimmed, isDeleted: false}})
      : await this.bagRepository.findOne({where: {bagNumber: Number(trimmed), isDeleted: false}});

    if (!bag) throw new HttpErrors.NotFound(`Bag "${q}" not found.`);
    if (!bag.isActive) throw new HttpErrors.BadRequest('This bag is inactive.');
    if (bag.status !== BagStatus.AVAILABLE) {
      throw new HttpErrors.Conflict(
        `Bag ${bag.bagNumber} is already ${bag.status === BagStatus.FULL ? 'full' : 'in use'}.`,
      );
    }

    return {id: bag.id, bagNumber: bag.bagNumber, status: bag.status, maxCapacity: bag.maxCapacity};
  }

  // ─── Rider-driven status transitions ────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @patch('/rider/pickup-requests/{id}/status')
  @response(200, {description: 'Pickup request status updated'})
  async updateStatus(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: {
              status: {type: 'string', enum: RIDER_STATUS_TRANSITIONS},
              bagId: {
                type: 'string',
                format: 'uuid',
                description: 'Required when status is picked_up — the bag from GET /rider/bags/lookup.',
              },
              itemsByService: {
                type: 'array',
                description: 'Required when status is picked_up — real counts confirmed at the doorstep.',
                items: {
                  type: 'object',
                  required: ['serviceId', 'quantity'],
                  properties: {
                    serviceId: {type: 'string', format: 'uuid'},
                    quantity: {type: 'number', minimum: 1},
                    deliverySpeed: {
                      type: 'string',
                      enum: Object.values(DeliveryType),
                      description: 'Real speed confirmed with the customer at the doorstep for this line — optional, but this is what the store should build the order against, not the pre-arrival estimate.',
                    },
                    remarks: {
                      type: 'string',
                      description: 'Optional rider note against this specific service line (e.g. a condition or count caveat noticed at the doorstep).',
                    },
                  },
                },
              },
              reasons: {
                type: 'array',
                description: 'Required when status is pickup_unsuccessful — one or more PickupUnsuccessfulReason values.',
                items: {type: 'string', enum: Object.values(PickupUnsuccessfulReason)},
              },
              otherReason: {
                type: 'string',
                description: 'Required when reasons includes "other".',
              },
            },
          },
        },
      },
    })
    body: {
      status: PickupRequestStatus;
      bagId?: string;
      itemsByService?: Array<{
        serviceId: string;
        quantity: number;
        deliverySpeed?: DeliveryType;
        remarks?: string;
      }>;
      reasons?: PickupUnsuccessfulReason[];
      otherReason?: string;
    },
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const pickupRequest = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    if (pickupRequest.assignedRiderId !== rider.id) {
      throw new HttpErrors.Forbidden('This pickup request is not assigned to you.');
    }
    if (!RIDER_STATUS_TRANSITIONS.includes(body.status)) {
      throw new HttpErrors.BadRequest(`Riders cannot set status to ${body.status}.`);
    }

    const current = pickupRequest.status ?? PickupRequestStatus.REQUESTED;
    const allowed = PICKUP_REQUEST_STATUS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(body.status)) {
      throw new HttpErrors.BadRequest(`Cannot move a pickup request from ${current} to ${body.status}.`);
    }

    // Confirming pickup now requires the real bag + real per-service counts
    // scanned/entered at the doorstep — this is the one place that data
    // gets attached, not a separate step.
    if (body.status === PickupRequestStatus.PICKED_UP) {
      if (!body.bagId || !body.itemsByService?.length) {
        throw new HttpErrors.BadRequest('bagId and itemsByService are required to confirm pickup.');
      }

      const bag = await this.assertBagAvailable(body.bagId);

      const serviceIds = [...new Set(body.itemsByService.map(i => i.serviceId))];
      const services = await this.serviceRepository.find({
        where: {id: {inq: serviceIds}, isDeleted: false, isActive: true} as object,
      });
      if (services.length !== serviceIds.length) {
        throw new HttpErrors.BadRequest('One or more services were not found or are inactive.');
      }
      const serviceNameById = new Map(services.map(s => [s.id, s.name]));

      const actualItemsByService = body.itemsByService.map(i => ({
        serviceId: i.serviceId,
        serviceName: serviceNameById.get(i.serviceId),
        quantity: i.quantity,
        deliverySpeed: i.deliverySpeed,
        remarks: i.remarks,
      }));
      const totalItems = actualItemsByService.reduce((sum, i) => sum + i.quantity, 0);

      const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
      try {
        await this.pickupRequestRepository.updateById(
          id,
          {status: body.status, bagId: body.bagId, actualItemsByService},
          {transaction: tx},
        );
        await this.bagRepository.updateById(
          bag.id,
          {status: BagStatus.IN_USE, itemCount: totalItems, currentPickupRequestId: id},
          {transaction: tx},
        );
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      return {message: 'Pickup confirmed.'};
    }

    // Structured, multi-select reason capture — the "Pickup Unsuccessful"
    // screen. Doesn't touch the bag (nothing was collected yet).
    if (body.status === PickupRequestStatus.PICKUP_UNSUCCESSFUL) {
      if (!body.reasons?.length) {
        throw new HttpErrors.BadRequest('reasons is required when marking a pickup unsuccessful.');
      }
      if (body.reasons.includes(PickupUnsuccessfulReason.OTHER) && !body.otherReason?.trim()) {
        throw new HttpErrors.BadRequest('otherReason is required when reasons includes "other".');
      }
      await this.pickupRequestRepository.updateById(id, {
        status: body.status,
        unsuccessfulReasons: body.reasons,
        unsuccessfulOtherReason: body.otherReason?.trim(),
        unsuccessfulAt: new Date(),
        unsuccessfulBy: currentUser[securityId],
      });
      return {message: 'Pickup marked unsuccessful.'};
    }

    await this.pickupRequestRepository.updateById(id, {status: body.status});

    // Back at the store — release the bag this pickup was using, same
    // shape as TransferController.receive()'s bag release.
    if (body.status === PickupRequestStatus.RECEIVED_AT_STORE && pickupRequest.bagId) {
      await this.bagRepository.updateById(pickupRequest.bagId, {
        status: BagStatus.AVAILABLE,
        itemCount: 0,
        currentPickupRequestId: null as unknown as string,
      });
    }

    return {message: 'Pickup request status updated.'};
  }

  // ─── Raise to support ────────────────────────────────────────────────────
  // A side-channel issue report against one of the rider's own pickups —
  // filing one does not block or change the pickup's own status/
  // transitions, it just gives the support team a queue to triage.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/pickup-requests/{id}/escalations')
  @response(200, {description: 'Escalation raised'})
  async raiseEscalation(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {type: 'string'},
              remark: {type: 'string'},
              mediaIds: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {reason: string; remark?: string; mediaIds?: string[]},
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const pickupRequest = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    if (pickupRequest.assignedRiderId !== rider.id) {
      throw new HttpErrors.Forbidden('This pickup request is not assigned to you.');
    }
    if (!body.reason?.trim()) throw new HttpErrors.BadRequest('reason is required.');

    const {v4} = await import('uuid');
    const escalation = await this.pickupEscalationRepository.create({
      id: v4(),
      pickupRequestId: id,
      pickupNumber: pickupRequest.pickupNumber,
      riderId: rider.id,
      riderName: `${rider.firstName} ${rider.lastName}`,
      reason: body.reason.trim(),
      remark: body.remark,
      mediaIds: body.mediaIds,
      raisedAt: new Date(),
      raisedBy: currentUser[securityId],
    });

    return {message: 'Escalation raised.', escalation};
  }

  // ─── The rider's own raised escalations for one pickup ───────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/pickup-requests/{id}/escalations')
  @response(200, {description: 'Escalations the calling rider raised for this pickup'})
  async myEscalations(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const escalations = await this.pickupEscalationRepository.find({
      where: {pickupRequestId: id, riderId: rider.id, isDeleted: false} as object,
      order: ['raisedAt DESC'],
    });
    return {escalations};
  }

  // ─── Reprocess a pickup that was marked unsuccessful ─────────────────────
  // A dedicated action, not a plain status-map transition — sends the same
  // pickup request back out (status → rider_assigned) rather than creating
  // a new one, and bumps reprocessCount for visibility. Stays with the same
  // rider; there's no reassignment step here.

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @post('/rider/pickup-requests/{id}/reprocess')
  @response(200, {description: 'Pickup request sent back out for another attempt'})
  async reprocess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const pickupRequest = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    if (pickupRequest.assignedRiderId !== rider.id) {
      throw new HttpErrors.Forbidden('This pickup request is not assigned to you.');
    }
    if (pickupRequest.status !== PickupRequestStatus.PICKUP_UNSUCCESSFUL) {
      throw new HttpErrors.BadRequest(
        `Cannot reprocess a pickup request that is ${pickupRequest.status}, not pickup_unsuccessful.`,
      );
    }

    await this.pickupRequestRepository.updateById(id, {
      status: PickupRequestStatus.RIDER_ASSIGNED,
      reprocessCount: (pickupRequest.reprocessCount ?? 0) + 1,
    });

    return {message: 'Pickup request sent back out for another attempt.'};
  }
}
