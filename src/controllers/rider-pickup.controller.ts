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
  PickupDeliverySlot,
  PickupHandoverBy,
  PickupRequest,
  UpgradeServiceChoice,
} from '../models';
import {PickupDeliverySlotType} from '../models/pickup-delivery-slot-type.enum';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {PICKUP_REQUEST_STATUS_TRANSITIONS, PickupRequestStatus} from '../models/pickup-request-status.enum';
import {
  CustomerRepository,
  PickupDeliverySlotRepository,
  PickupRequestRepository,
  RiderRepository,
  RolesRepository,
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
  PickupRequestStatus.PICKED_UP,
  PickupRequestStatus.RECEIVED_AT_STORE,
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
    @param.query.string('status') status?: PickupRequestStatus,
  ): Promise<PickupRequest[]> {
    const rider = await this.resolveActiveRider(currentUser);
    return this.pickupRequestRepository.find({
      where: {
        assignedRiderId: rider.id,
        isDeleted: false,
        ...(status
          ? {status}
          : {status: {inq: [PickupRequestStatus.RIDER_ASSIGNED, PickupRequestStatus.OUT_FOR_PICKUP]}}),
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
                  required: ['itemCategoryId', 'quantity'],
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
                  'true: attach to the rider\'s current out_for_pickup run (must have one). ' +
                  'false: create a standalone new run — storeId then becomes required.',
              },
              storeId: {
                type: 'string',
                format: 'uuid',
                description: 'Required when pickupNow is false — nothing to inherit it from.',
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
        itemCategoryId: string;
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

    const base = {
      id: v4(),
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
      if (!currentRun) {
        throw new HttpErrors.BadRequest('No ongoing pickup run to attach to — assign yourself a pickup first.');
      }
      const pickupRequest = await this.pickupRequestRepository.create({
        ...base,
        storeId: currentRun.storeId,
        runId: currentRun.runId,
        status: PickupRequestStatus.OUT_FOR_PICKUP,
      });
      return {message: 'Pickup request created and attached to the current run.', pickupRequest};
    }

    if (!body.storeId) {
      throw new HttpErrors.BadRequest('storeId is required when pickupNow is false.');
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
            properties: {status: {type: 'string', enum: RIDER_STATUS_TRANSITIONS}},
          },
        },
      },
    })
    body: {status: PickupRequestStatus},
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

    await this.pickupRequestRepository.updateById(id, {status: body.status});
    return {message: 'Pickup request status updated.'};
  }
}
