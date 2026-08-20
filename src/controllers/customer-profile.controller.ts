import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {PresstoDataSource} from '../datasources';
import {
  ColourBleedingChoice,
  ContactRelationship,
  Customer,
  CustomerAddress,
  CustomerContact,
  CustomerPhone,
  CustomerPreference,
  ItemCategory,
  PickupDeliverySlot,
  PickupDeliverySlotType,
  PickupHandoverBy,
  PickupRequest,
  UpgradeServiceChoice,
} from '../models';
import {PICKUP_REQUEST_STATUS_TRANSITIONS, PickupRequestStatus} from '../models/pickup-request-status.enum';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {
  CustomerRepository,
  CustomerSecurityDepositRepository,
  ItemCategoryRepository,
  PickupDeliverySlotRepository,
  PickupRequestRepository,
  UsersRepository,
  WalletRepository,
  WalletTransactionRepository,
} from '../repositories';
import {CouponService, EligibleCouponDisplay} from '../services/coupon.service';
import {CustomerAddressService} from '../services/customer-address.service';
import {CustomerContactService} from '../services/customer-contact.service';
import {CustomerPhoneService} from '../services/customer-phone.service';
import {CustomerPreferenceChanges, CustomerPreferenceService} from '../services/customer-preference.service';
import {filterSlotsForDate} from '../utils/pickup-slot-availability';

export class CustomerProfileController {
  constructor(
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(WalletRepository)
    private walletRepository: WalletRepository,
    @repository(WalletTransactionRepository)
    private walletTransactionRepository: WalletTransactionRepository,
    @repository(CustomerSecurityDepositRepository)
    private securityDepositRepository: CustomerSecurityDepositRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('services.customer-address')
    private addressService: CustomerAddressService,
    @inject('services.customer-contact')
    private contactService: CustomerContactService,
    @inject('services.customer-phone')
    private phoneService: CustomerPhoneService,
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(PickupDeliverySlotRepository)
    private pickupSlotRepository: PickupDeliverySlotRepository,
    @repository(ItemCategoryRepository)
    private itemCategoryRepository: ItemCategoryRepository,
    @inject('services.customer-preference')
    private preferenceService: CustomerPreferenceService,
    @inject('services.coupon')
    private couponService: CouponService,
  ) {}

  private async resolveCustomer(userId: string): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: {userId, isDeleted: false},
    });
    if (!customer) {
      throw new HttpErrors.NotFound('Customer profile not found for this user.');
    }
    return customer;
  }

  private verifyOwnership(recordCustomerId: string, customerId: string): void {
    if (recordCustomerId !== customerId) {
      throw new HttpErrors.Forbidden('You do not have permission to modify this record.');
    }
  }

  // ─── Profile ──────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer')
  @response(200, {description: 'Customer profile'})
  async getProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const userId = currentUser[securityId];

    const customer = await this.customerRepository.findOne({
      where: {userId, isDeleted: false},
      include: [
        {
          relation: 'user',
          scope: {
            fields: {id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true},
            include: [{relation: 'roles'}],
          },
        },
      ],
    });

    if (!customer) throw new HttpErrors.NotFound('Customer profile not found.');

    const [wallet, securityDeposit] = await Promise.all([
      this.walletRepository.findOne({where: {customerId: customer.id}}),
      this.securityDepositRepository.findOne({where: {customerId: customer.id}}),
    ]);

    return {...customer, wallet, securityDeposit};
  }

  @authenticate('jwt')
  @patch('/profile/customer')
  @response(204, {description: 'Customer profile updated'})
  async updateProfile(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // user-level — only what the customer owns
              email: {type: 'string', format: 'email'},
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              // customer-level — personal info only, no admin fields
              firstName: {type: 'string'},
              lastName: {type: 'string'},
              dateOfBirth: {type: 'string', format: 'date'},
              gstNumber: {type: 'string'},
              companyName: {type: 'string'},
              // excluded: customerTypeId, customerGroupId, loyaltyPoints,
              //           defaultDiscountType, defaultDiscountValue,
              //           preferredStoreId, sensitivityScore, notes (all admin-only)
            },
          },
        },
      },
    })
    body: {
      email?: string;
      countryCode?: string;
      phone?: string;
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
      gstNumber?: string;
      companyName?: string;
    },
  ): Promise<void> {
    const userId = currentUser[securityId];
    const customer = await this.resolveCustomer(userId);

    const {email, countryCode, phone, firstName, lastName, dateOfBirth, ...customerRest} = body;

    const userFields: Record<string, unknown> = {};
    if (email !== undefined) userFields.email = email;
    if (countryCode !== undefined) userFields.countryCode = countryCode;
    if (phone !== undefined) userFields.phone = phone;
    if (firstName !== undefined || lastName !== undefined) {
      const newFirst = firstName ?? customer.firstName;
      const newLast = lastName ?? customer.lastName;
      userFields.fullName = `${newFirst} ${newLast}`;
    }

    const customerFields: Record<string, unknown> = {...customerRest};
    if (firstName !== undefined) customerFields.firstName = firstName;
    if (lastName !== undefined) customerFields.lastName = lastName;
    if (dateOfBirth !== undefined) customerFields.dateOfBirth = new Date(dateOfBirth);

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      if (Object.keys(userFields).length > 0) {
        await this.usersRepository.updateById(userId, userFields, {transaction: tx});
      }
      if (Object.keys(customerFields).length > 0) {
        await this.customerRepository.updateById(customer.id, customerFields, {transaction: tx});
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── Wallet ───────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/wallet')
  @response(200, {description: 'Wallet balance and recent transactions'})
  async getWallet(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser[securityId]);

    const wallet = await this.walletRepository.findOne({where: {customerId: customer.id}});
    if (!wallet) throw new HttpErrors.NotFound('Wallet not found.');

    const recentTransactions = await this.walletTransactionRepository.find({
      where: {walletId: wallet.id, isDeleted: false},
      order: ['transactionDate DESC'],
      limit: 20,
    });

    return {wallet, recentTransactions};
  }

  // ─── Security Deposit ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/security-deposit')
  @response(200, {description: 'Security deposit info'})
  async getSecurityDeposit(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser[securityId]);

    const deposit = await this.securityDepositRepository.findOne({
      where: {customerId: customer.id},
    });
    if (!deposit) throw new HttpErrors.NotFound('Security deposit record not found.');

    return deposit;
  }

  // ─── Addresses ────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/addresses')
  @response(200, {description: 'Customer addresses', content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(CustomerAddress)}}}})
  async getAddresses(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<CustomerAddress[]> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.addressService.findAll(customer.id);
  }

  @authenticate('jwt')
  @post('/profile/customer/addresses')
  @response(200, {description: 'Address added', content: {'application/json': {schema: getModelSchemaRef(CustomerAddress)}}})
  async addAddress(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
              doorFloorFlat: {type: 'string', description: 'Door/floor/flat number'},
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
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.addressService.create(customer.id, body);
  }

  @authenticate('jwt')
  @patch('/profile/customer/addresses/{id}')
  @response(204, {description: 'Address updated'})
  async updateAddress(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              addressType: {type: 'string'},
              addressName: {type: 'string', description: "e.g. Father's home, 2nd office"},
              addressLine1: {type: 'string'},
              addressLine2: {type: 'string'},
              doorFloorFlat: {type: 'string', description: 'Door/floor/flat number'},
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
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const address = await this.addressService.findById(id);
    this.verifyOwnership(address.customerId, customer.id);
    await this.addressService.update(id, body);
  }

  @authenticate('jwt')
  @del('/profile/customer/addresses/{id}')
  @response(204, {description: 'Address deleted'})
  async deleteAddress(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const address = await this.addressService.findById(id);
    this.verifyOwnership(address.customerId, customer.id);
    await this.addressService.delete(id);
  }

  // ─── Contacts ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/contacts')
  @response(200, {description: 'Customer contacts', content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(CustomerContact)}}}})
  async getContacts(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<CustomerContact[]> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.contactService.findAll(customer.id);
  }

  @authenticate('jwt')
  @post('/profile/customer/contacts')
  @response(200, {description: 'Contact added', content: {'application/json': {schema: getModelSchemaRef(CustomerContact)}}})
  async addContact(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
  ): Promise<CustomerContact> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.contactService.create(customer.id, body);
  }

  @authenticate('jwt')
  @patch('/profile/customer/contacts/{id}')
  @response(204, {description: 'Contact updated'})
  async updateContact(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
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
    body: Partial<CustomerContact>,
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const contact = await this.contactService.findById(id);
    this.verifyOwnership(contact.customerId, customer.id);
    await this.contactService.update(id, body);
  }

  @authenticate('jwt')
  @del('/profile/customer/contacts/{id}')
  @response(204, {description: 'Contact deleted'})
  async deleteContact(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const contact = await this.contactService.findById(id);
    this.verifyOwnership(contact.customerId, customer.id);
    await this.contactService.delete(id);
  }

  // ─── Alternate Phones ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/phones')
  @response(200, {description: 'Customer alternate phones', content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(CustomerPhone)}}}})
  async getPhones(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<CustomerPhone[]> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.phoneService.findAll(customer.id);
  }

  @authenticate('jwt')
  @post('/profile/customer/phones')
  @response(200, {description: 'Phone added', content: {'application/json': {schema: getModelSchemaRef(CustomerPhone)}}})
  async addPhone(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['countryCode', 'phone'],
            properties: {
              countryCode: {type: 'string', default: '+91'},
              phone: {type: 'string'},
              isPrimary: {type: 'boolean'},
              isWhatsappNumber: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: {countryCode: string; phone: string; isPrimary?: boolean; isWhatsappNumber?: boolean},
  ): Promise<CustomerPhone> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.phoneService.create(customer.id, body);
  }

  @authenticate('jwt')
  @patch('/profile/customer/phones/{id}')
  @response(204, {description: 'Phone updated'})
  async updatePhone(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              countryCode: {type: 'string'},
              phone: {type: 'string'},
              isPrimary: {type: 'boolean'},
              isWhatsappNumber: {type: 'boolean'},
            },
          },
        },
      },
    })
    body: Partial<CustomerPhone>,
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const phone = await this.phoneService.findById(id);
    this.verifyOwnership(phone.customerId, customer.id);
    await this.phoneService.update(id, body);
  }

  @authenticate('jwt')
  @del('/profile/customer/phones/{id}')
  @response(204, {description: 'Phone deleted'})
  async deletePhone(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<void> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const phone = await this.phoneService.findById(id);
    this.verifyOwnership(phone.customerId, customer.id);
    await this.phoneService.delete(id);
  }

  // ─── Pickup Requests ────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/pickup-slots')
  @response(200, {
    description: 'Active pickup slots — pass date to hide slots less than 90 minutes out when date is today',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(PickupDeliverySlot)}}},
  })
  async getPickupSlots(
    @param.query.string('date') date?: string,
  ): Promise<PickupDeliverySlot[]> {
    const slots = await this.pickupSlotRepository.find({
      where: {
        isActive: true,
        isDeleted: false,
        type: {inq: [PickupDeliverySlotType.PICKUP, PickupDeliverySlotType.BOTH]},
      } as object,
      order: ['sortOrder ASC', 'startTime ASC'],
    });
    return filterSlotsForDate(slots, date);
  }

  @authenticate('jwt')
  @get('/profile/customer/item-categories')
  @response(200, {
    description: 'Active item categories, for a per-category pickup estimate (e.g. clothes vs curtains)',
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(ItemCategory)}}},
  })
  async getItemCategories(): Promise<ItemCategory[]> {
    return this.itemCategoryRepository.find({
      where: {isActive: true, isDeleted: false} as object,
      order: ['sequence ASC', 'name ASC'],
    });
  }

  @authenticate('jwt')
  @get('/profile/customer/pickup-requests')
  @response(200, {
    description: "Caller's own pickup requests",
    content: {'application/json': {schema: {type: 'array', items: getModelSchemaRef(PickupRequest)}}},
  })
  async getPickupRequests(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<PickupRequest[]> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.pickupRequestRepository.find({
      where: {customerId: customer.id, isDeleted: false} as object,
      order: ['createdAt DESC'],
    });
  }

  @authenticate('jwt')
  @get('/profile/customer/pickup-requests/{id}')
  @response(200, {description: 'Pickup request detail'})
  async getPickupRequestById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<PickupRequest> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const pickupRequest = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false} as object});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    this.verifyOwnership(pickupRequest.customerId ?? '', customer.id);
    return pickupRequest;
  }

  @authenticate('jwt')
  @post('/profile/customer/pickup-requests')
  @response(200, {description: 'Pickup request created'})
  async createPickupRequest(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['addressId', 'slotId', 'requestedDate', 'handoverBy'],
            properties: {
              addressId: {type: 'string', format: 'uuid'},
              slotId: {type: 'string', format: 'uuid'},
              requestedDate: {type: 'string', format: 'date'},
              handoverBy: {type: 'string', enum: Object.values(PickupHandoverBy)},
              handoverPersonName: {
                type: 'string',
                description: 'Required unless handoverBy is "self".',
              },
              itemCountEstimate: {type: 'number'},
              itemCategoryEstimate: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['itemCategoryId', 'quantity'],
                  properties: {
                    itemCategoryId: {type: 'string', format: 'uuid'},
                    quantity: {type: 'number'},
                  },
                },
                description: 'Per-category counts (from GET /profile/customer/item-categories), e.g. how many clothes vs curtains — used to size the pickup (bike vs van).',
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
            },
          },
        },
      },
    })
    body: {
      addressId: string;
      slotId: string;
      requestedDate: string;
      handoverBy: PickupHandoverBy;
      handoverPersonName?: string;
      itemCountEstimate?: number;
      itemCategoryEstimate?: Array<{itemCategoryId: string; quantity: number}>;
      remarks?: string;
      mediaIds?: string[];
    },
  ): Promise<object> {
    const userId = currentUser[securityId];
    const customer = await this.resolveCustomer(userId);

    const address = await this.addressService.findById(body.addressId);
    this.verifyOwnership(address.customerId, customer.id);

    const slot = await this.pickupSlotRepository.findOne({
      where: {id: body.slotId, isActive: true, isDeleted: false} as object,
    });
    if (!slot) throw new HttpErrors.BadRequest('Pickup slot not found or inactive.');

    if (body.handoverBy !== PickupHandoverBy.SELF && !body.handoverPersonName?.trim()) {
      throw new HttpErrors.BadRequest('handoverPersonName is required unless handoverBy is "self".');
    }

    const user = await this.usersRepository.findById(userId);

    // "Apply to all orders" fallback — per field independently. An
    // explicit value in the request body always wins; the stored default
    // only fills in a field the caller left out entirely.
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
    const pickupRequest = await this.pickupRequestRepository.create({
      id: v4(),
      customerId: customer.id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerCountryCode: user.countryCode ?? '+91',
      customerMobile: user.phone,
      address: this.addressService.toDisplaySnapshot(address),
      pincode: address.pincode,
      requestedDate: body.requestedDate,
      slot: slot.label,
      pickupSlotId: slot.id,
      source: PickupRequestSource.WEB,
      handoverBy: body.handoverBy,
      handoverPersonName: body.handoverBy === PickupHandoverBy.SELF ? undefined : body.handoverPersonName,
      itemCountEstimate: body.itemCountEstimate,
      itemCategoryEstimate: body.itemCategoryEstimate,
      remarks,
      mediaIds,
    });
    return {message: 'Pickup request created.', pickupRequest};
  }

  @authenticate('jwt')
  @patch('/profile/customer/pickup-requests/{id}/cancel')
  @response(200, {description: 'Pickup request cancelled'})
  async cancelPickupRequest(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const pickupRequest = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false} as object});
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    this.verifyOwnership(pickupRequest.customerId ?? '', customer.id);

    const current = pickupRequest.status ?? PickupRequestStatus.REQUESTED;
    if (!PICKUP_REQUEST_STATUS_TRANSITIONS[current]?.includes(PickupRequestStatus.CANCELLED)) {
      throw new HttpErrors.BadRequest(`Cannot cancel a pickup request that is already ${current}.`);
    }

    await this.pickupRequestRepository.updateById(id, {status: PickupRequestStatus.CANCELLED});
    return {message: 'Pickup request cancelled.'};
  }

  // ─── Coupons ────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/coupons/active')
  @response(200, {description: 'Active coupons this customer is currently eligible for (home-screen offers)'})
  async getActiveCoupons(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('storeId') storeId?: string,
  ): Promise<EligibleCouponDisplay[]> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    const resolvedStoreId = storeId ?? customer.preferredStoreId;
    return this.couponService.listEligibleForDisplay(customer.id, resolvedStoreId);
  }

  // ─── Preferences ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @get('/profile/customer/preferences')
  @response(200, {
    description: "Caller's stored preferences (created with defaults on first read)",
    content: {'application/json': {schema: getModelSchemaRef(CustomerPreference)}},
  })
  async getPreferences(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<CustomerPreference> {
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.preferenceService.getOrCreate(customer.id);
  }

  @authenticate('jwt')
  @patch('/profile/customer/preferences')
  @response(200, {
    description: 'Updated preferences',
    content: {'application/json': {schema: getModelSchemaRef(CustomerPreference)}},
  })
  async updatePreferences(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const customer = await this.resolveCustomer(currentUser[securityId]);
    return this.preferenceService.update(customer.id, body, customer.id);
  }
}
