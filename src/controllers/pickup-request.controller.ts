import {PickupRequestService} from '../services/pickup-request.service';
import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, repository} from '@loopback/repository';
import {del, get, getModelSchemaRef, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {RiderAssignmentService} from '../services/rider-assignment.service';
import {StoreScope, StoreScopeService} from '../services/store-scope.service';
import {CustomerAddressService, PickupStoreResolution} from '../services/customer-address.service';
import {NotificationService, RIDER_NOTIFICATION_TYPES} from '../services/notification.service';
import {SystemNotificationService} from '../services/system-notification.service';
import {PickupRequest} from '../models';
import {RiderPincodeMappingWithRelations} from '../models/rider-pincode-mapping.model';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {PickupCancellationReason} from '../models/pickup-cancellation-reason.enum';
import {PICKUP_REQUEST_STATUS_TRANSITIONS, PickupRequestStatus} from '../models/pickup-request-status.enum';
import {DeliveryType} from '../models/delivery-type.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {
  ApprovalRequestRepository,
  BagRepository,
  CustomerRepository,
  ItemCategoryRepository,
  ItemRepository,
  MediaRepository,
  OrderRepository,
  OrderItemRepository,
  PickupDeliverySlotRepository,
  PickupEscalationRepository,
  PickupRequestRepository,
  RiderPincodeMappingRepository,
  RiderRepository,
  ServiceCategoryRepository,
  ServiceRepository,
  StoreRepository,
} from '../repositories';

interface CreateBody {
  customerId?: string;
  customerName: string;
  customerCountryCode?: string;
  customerMobile: string;
  address: string;
  pincode?: string;
  requestedDate: string;
  slot: string;
  slotId?: string;
  storeId?: string;
  source: PickupRequestSource;
  itemCountEstimate?: number;
  itemCategoryEstimate?: Array<{
    itemCategoryId?: string;
    quantity: number;
    serviceId?: string;
    deliverySpeed?: DeliveryType;
  }>;
  remarks?: string;
  isReworkPickup?: boolean;
  reworkOfOrderId?: string;
  reworkApprovalRequestId?: string;
}

interface UpdateBody {
  customerName?: string;
  customerCountryCode?: string;
  customerMobile?: string;
  address?: string;
  pincode?: string;
  requestedDate?: string;
  slot?: string;
  storeId?: string;
  itemCountEstimate?: number;
  remarks?: string;
  status?: PickupRequestStatus;
  convertedOrderId?: string;
  deliverySpeed?: DeliveryType;
  cancellationReason?: string;
  cancellationOtherReason?: string;
}

// Statuses in which an admin may still change the processing store — see
// assertProcessingStoreChangeable.
export const PROCESSING_STORE_CHANGEABLE_STATUSES: string[] = [
  PickupRequestStatus.REQUESTED,
  PickupRequestStatus.SCHEDULED,
  PickupRequestStatus.RIDER_ASSIGNED,
  PickupRequestStatus.OUT_FOR_PICKUP,
  PickupRequestStatus.ARRIVED_AT_PICKUP,
  PickupRequestStatus.PICKED_UP,
  PickupRequestStatus.PICKUP_UNSUCCESSFUL,
];

// A pickup with no store in these statuses is visible to global admins only.
const GLOBAL_ONLY_UNOWNED_STATUSES: string[] = [
  PickupRequestStatus.NOT_SERVICEABLE,
  PickupRequestStatus.CANCELLED,
];

/**
 * Which pickup requests a store-scoped caller sees in the list.
 *
 * A pickup with a storeId belongs to that store. One without a storeId
 * either is not assigned yet (call-center intake often doesn't know the
 * destination store — see PickupRequest.storeId) or is NOT_SERVICEABLE.
 * A not-serviceable one carries nearestStoreId and is shown only to that
 * store, not to every store. nearestStoreId is set on nothing else.
 *
 * `lenient` (no explicit store/cluster filter): open unassigned pickups
 * are still shown so nothing becomes invisible to everyone. A
 * not-serviceable or cancelled pickup with no store is never shown to
 * every store: it is left to global (all-store) admins, who skip this
 * filter entirely. An explicit store/cluster filter is exact: only that
 * store's own pickups and its not-serviceable ones.
 */
export function pickupScopeWhere(storeIds: string[], lenient: boolean): object {
  const owned: object[] = [
    {storeId: {inq: storeIds}},
    {storeId: null, nearestStoreId: {inq: storeIds}},
  ];
  // A cancelled pickup with no store is no work for any store — and one
  // cancelled from not-serviceable would otherwise reappear everywhere.
  const unassigned = {
    storeId: null,
    nearestStoreId: null,
    status: {nin: GLOBAL_ONLY_UNOWNED_STATUSES},
  };
  return {or: lenient ? [...owned, unassigned] : owned};
}

export class PickupRequestController {
  constructor(
    @inject('services.pickup-request')
    private pickupRequestService: PickupRequestService,
    @repository(PickupRequestRepository)
    private pickupRequestRepository: PickupRequestRepository,
    @repository(RiderRepository)
    private riderRepository: RiderRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(StoreRepository)
    private storeRepository: StoreRepository,
    @repository(PickupDeliverySlotRepository)
    private pickupSlotRepository: PickupDeliverySlotRepository,
    @repository(PickupEscalationRepository)
    private pickupEscalationRepository: PickupEscalationRepository,
    @repository(RiderPincodeMappingRepository)
    private riderPincodeMappingRepository: RiderPincodeMappingRepository,
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(OrderItemRepository)
    private orderItemRepository: OrderItemRepository,
    @repository(ApprovalRequestRepository)
    private approvalRequestRepository: ApprovalRequestRepository,
    @repository(BagRepository)
    private bagRepository: BagRepository,
    @repository(MediaRepository)
    private mediaRepository: MediaRepository,
    @repository(ItemCategoryRepository)
    private itemCategoryRepository: ItemCategoryRepository,
    @repository(ItemRepository)
    private itemRepository: ItemRepository,
    @repository(ServiceRepository)
    private serviceRepository: ServiceRepository,
    @repository(ServiceCategoryRepository)
    private serviceCategoryRepository: ServiceCategoryRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
    @inject('services.rider-assignment')
    private riderAssignmentService: RiderAssignmentService,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @inject('services.notification')
    private notificationService: NotificationService,
    @inject('services.system-notification', {optional: true})
    private systemNotificationService?: SystemNotificationService,
  ) {}

  // ─── Validation helpers ───────────────────────────────────────────────────

  private assertTransition(current: PickupRequestStatus, next: PickupRequestStatus) {
    const allowed = PICKUP_REQUEST_STATUS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new HttpErrors.BadRequest(`Cannot move a pickup request from ${current} to ${next}.`);
    }
  }

  // Changing a pickup's processing store (PATCH storeId). Allowed until the
  // bag is committed to a store: once received_at_store, home-pickup order
  // drafts must match pickup.storeId (OrderService submit check), and once
  // the rider has batched it into a pending handover, that handover already
  // names its destination store. Terminal/never-serviceable pickups are
  // locked too. A scoped caller may only move a pickup to one of their own
  // stores.
  private async assertProcessingStoreChangeable(
    pickup: PickupRequest,
    newStoreId: string,
    scope: StoreScope,
  ): Promise<void> {
    const status = pickup.status ?? PickupRequestStatus.REQUESTED;
    if (!PROCESSING_STORE_CHANGEABLE_STATUSES.includes(status)) {
      throw new HttpErrors.BadRequest(
        `The processing store cannot be changed once the pickup is ${status}.`,
      );
    }
    if (pickup.convertedOrderId || Object.keys(pickup.convertedOrders ?? {}).length) {
      throw new HttpErrors.BadRequest(
        'The processing store cannot be changed after an order has been created from this pickup.',
      );
    }
    const store = await this.storeRepository.findOne({where: {id: newStoreId, isDeleted: false} as object});
    if (!store) throw new HttpErrors.NotFound('Store not found.');
    if (!scope.global && !scope.storeIds.includes(String(newStoreId))) {
      throw new HttpErrors.Forbidden('You can only move a pickup to a store you manage.');
    }
    if (status === PickupRequestStatus.PICKED_UP) {
      const pending = (await this.dataSource.execute(
        `SELECT 1
         FROM public.pickup_handover_item i
         JOIN public.pickup_handover h ON h.id = i.pickuphandoverid
         WHERE i.pickuprequestid = $1
           AND h.isdeleted = false
           AND h.status = 'pending'
         LIMIT 1`,
        [pickup.id],
      )) as unknown[];
      if (pending.length) {
        throw new HttpErrors.Conflict(
          'The rider has already started a handover for this pickup. Reject or complete that handover before changing the processing store.',
        );
      }
    }
  }

  // Same IDOR guard Orders applies via StoreScopeService.assertOrderVisible
  // — a scoped caller can't read/update/delete a pickup request outside
  // their store(s) just by knowing its id. A not-yet-assigned pickup
  // (storeId unset — see PickupRequest.storeId) stays visible to any
  // scoped caller, matching find()'s leniency for the same reason.
  // A not-serviceable pickup (no storeId) belongs to its nearestStoreId
  // instead — see pickupScopeWhere.
  private assertPickupScopeVisible(
    scope: StoreScope,
    pickup: {storeId?: string | null; nearestStoreId?: string | null; status?: string | null},
  ): void {
    if (scope.global) return;
    const owningStoreId = pickup.storeId || pickup.nearestStoreId;
    if (owningStoreId) {
      if (scope.storeIds.includes(String(owningStoreId))) return;
      throw new HttpErrors.NotFound('Pickup request not found.');
    }
    // No store at all: an open unassigned intake stays visible to any store,
    // but a not-serviceable or cancelled one is global-only (same rule as
    // pickupScopeWhere).
    if (GLOBAL_ONLY_UNOWNED_STATUSES.includes(String(pickup.status))) {
      throw new HttpErrors.NotFound('Pickup request not found.');
    }
  }

  private async assertRiderAssignable(riderId: string) {
    const rider = await this.riderRepository.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');
    if (!rider.isActive) throw new HttpErrors.BadRequest('This rider is inactive.');
    return rider;
  }

  /** Resolves a slotId into its label — 400 if missing/inactive. */
  private async resolveSlotLabel(slotId: string): Promise<string> {
    const slot = await this.pickupSlotRepository.findOne({
      where: {id: slotId, isActive: true, isDeleted: false} as object,
    });
    if (!slot) throw new HttpErrors.BadRequest('Pickup slot not found or inactive.');
    return slot.label;
  }

  /**
   * Advisory only — batch-resolves each request's suggestedRiderId/Name from
   * the active RiderPincodeMapping for its pincode. The admin can still
   * assign a different rider via assign(); this is purely a UI hint for
   * grouping same-pincode requests onto the rider who already covers them.
   */
  private async enrichWithSuggestedRider(requests: PickupRequest[]): Promise<object[]> {
    const pincodes = [...new Set(requests.map(r => r.pincode).filter((p): p is string => Boolean(p)))];
    if (!pincodes.length) return requests;

    const mappings: RiderPincodeMappingWithRelations[] = await this.riderPincodeMappingRepository.find({
      where: {pincode: {inq: pincodes}, isActive: true, isDeleted: false} as object,
      include: [{relation: 'rider'}],
    });
    const mappingByPincode = new Map(mappings.map(m => [m.pincode, m]));

    return requests.map(r => {
      const mapping = r.pincode ? mappingByPincode.get(r.pincode) : undefined;
      return {
        ...r,
        suggestedRiderId: mapping?.riderId ?? null,
        suggestedRiderName: mapping?.rider
          ? `${mapping.rider.firstName} ${mapping.rider.lastName}`
          : null,
      };
    });
  }

  // Resolves reworkOfOrderId to a human-readable order number, for the
  // pickup list's "Rework" column — the model only stores the id.
  private async enrichWithReworkOrderNumber(requests: object[]): Promise<object[]> {
    const orderIds = [
      ...new Set(
        requests
          .map(r => (r as {reworkOfOrderId?: string}).reworkOfOrderId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!orderIds.length) return requests;

    const orders = await this.orderRepository.find({
      where: {id: {inq: orderIds}} as object,
      fields: {id: true, orderNumber: true} as object,
    });
    const orderNumberById = new Map(orders.map(o => [o.id, o.orderNumber]));

    return requests.map(r => {
      const reworkOfOrderId = (r as {reworkOfOrderId?: string}).reworkOfOrderId;
      return {
        ...r,
        reworkOfOrderNumber: reworkOfOrderId ? orderNumberById.get(reworkOfOrderId) ?? null : null,
      };
    });
  }

  // ─── Store suggestion ───────────────────────────────────────────────────────

  // Advisory only: staff can still pick another store, or go ahead when no
  // store is found, while store coordinates are incomplete.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:create']})
  @get('/pickup-requests/store-suggestion')
  @response(200, {description: 'The store that serves a pickup at this saved address, if any'})
  async suggestStore(
    @param.query.string('customerAddressId', {required: true}) customerAddressId: string,
    @inject('services.customer-address') addressService: CustomerAddressService,
  ): Promise<PickupStoreResolution> {
    const address = await addressService.findById(customerAddressId);
    if (address.isDeleted) throw new HttpErrors.NotFound('Address not found.');
    return addressService.suggestPickupStoreForStaff(address);
  }

  // ─── Create ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:create']})
  @post('/pickup-requests')
  @response(200, {description: 'Pickup request created'})
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customerName', 'customerMobile', 'address', 'requestedDate', 'slot', 'source'],
            properties: {
              customerId: {type: 'string', format: 'uuid'},
              customerName: {type: 'string'},
              customerCountryCode: {type: 'string', default: '+91'},
              customerMobile: {type: 'string'},
              address: {type: 'string'},
              pincode: {type: 'string'},
              requestedDate: {type: 'string', format: 'date'},
              slot: {type: 'string'},
              slotId: {
                type: 'string',
                format: 'uuid',
                description: 'If given, overrides slot with this slot\'s label.',
              },
              storeId: {type: 'string', format: 'uuid'},
              source: {type: 'string', enum: Object.values(PickupRequestSource)},
              itemCountEstimate: {type: 'number'},
              itemCategoryEstimate: {
                type: 'array',
                description: 'Per-category counts (e.g. how many clothes vs curtains) — used to size the pickup (bike vs van). Not binding; the real order is built after in-store inspection.',
                items: {
                  type: 'object',
                  required: ['quantity'],
                  properties: {
                    itemCategoryId: {type: 'string', format: 'uuid'},
                    quantity: {type: 'number'},
                    serviceId: {type: 'string', format: 'uuid'},
                    deliverySpeed: {type: 'string', enum: Object.values(DeliveryType)},
                  },
                },
              },
              remarks: {type: 'string'},
              isReworkPickup: {
                type: 'boolean',
                description:
                  'This pickup is to bring back a garment for a free rework, not a new paid ' +
                  'order — requires reworkOfOrderId and reworkApprovalRequestId. The free ' +
                  'rework ticket is created immediately for staff requests or after customer request approval.',
              },
              reworkOfOrderId: {type: 'string', format: 'uuid'},
              reworkApprovalRequestId: {type: 'string', format: 'uuid'},
            },
          },
        },
      },
    })
    body: CreateBody,
  ): Promise<object> {
    if (body.customerId) {
      const customer = await this.customerRepository.findOne({
        where: {id: body.customerId, isDeleted: false},
      });
      if (!customer) throw new HttpErrors.NotFound('Customer not found.');
    }
    if (body.storeId) {
      const store = await this.storeRepository.findOne({where: {id: body.storeId}});
      if (!store) throw new HttpErrors.NotFound('Store not found.');
    }
    if (body.itemCategoryEstimate?.length && !body.isReworkPickup) {
      const categoryIds = [...new Set(body.itemCategoryEstimate.map(line => line.itemCategoryId).filter((id): id is string => Boolean(id)))];
      const serviceIds = [...new Set(body.itemCategoryEstimate.map(line => line.serviceId).filter((id): id is string => Boolean(id)))];
      const categoryWhere = {where: {id: {inq: categoryIds}, isDeleted: false, isActive: true} as object};
      const [itemCategories, serviceCategories, services] = await Promise.all([
        categoryIds.length ? this.itemCategoryRepository.find(categoryWhere) : [],
        categoryIds.length ? this.serviceCategoryRepository.find(categoryWhere) : [],
        serviceIds.length
          ? this.serviceRepository.find({where: {id: {inq: serviceIds}, isDeleted: false, isActive: true} as object})
          : [],
      ]);
      if (itemCategories.length + serviceCategories.length !== categoryIds.length) {
        throw new HttpErrors.BadRequest('Select valid categories for this pickup.');
      }
      if (services.length !== serviceIds.length) {
        throw new HttpErrors.BadRequest('Select valid services for this pickup.');
      }
    }
    if (body.isReworkPickup) {
      if (!body.reworkOfOrderId || !body.reworkApprovalRequestId) {
        throw new HttpErrors.BadRequest(
          'A rework pickup needs both reworkOfOrderId and reworkApprovalRequestId.',
        );
      }
      const approval = await this.approvalRequestRepository.findOne({
        where: {
          id: body.reworkApprovalRequestId,
          type: ApprovalRequestType.REPROCESS,
          entityType: 'order',
          entityId: body.reworkOfOrderId,
        } as object,
      });
      if (!approval) {
        throw new HttpErrors.NotFound('No matching reprocess request found for this order.');
      }
      if (body.itemCategoryEstimate?.length) {
        const originalItems = await this.orderItemRepository.find({where: {orderId: body.reworkOfOrderId}});
        const itemIds = [...new Set(originalItems.map(item => item.itemId))];
        const originalCatalogItems = itemIds.length
          ? await this.itemRepository.find({where: {id: {inq: itemIds}} as object})
          : [];
        const categoryByItemId = new Map(originalCatalogItems.map(item => [item.id, item.itemCategoryId]));
        const originalPairs = new Set(originalItems.map(item =>
          `${item.serviceId}:${categoryByItemId.get(item.itemId)}`));
        const originalServiceIds = new Set(originalItems.map(item => item.serviceId));
        const isOriginalPair = (line: {serviceId?: string; itemCategoryId?: string}) =>
          originalPairs.has(`${line.serviceId}:${line.itemCategoryId}`);
        // Lines added by hand may carry the service's own category instead of an item category.
        const lineServiceIds = [...new Set(body.itemCategoryEstimate
          .filter(line => line.itemCategoryId && !isOriginalPair(line))
          .map(line => line.serviceId)
          .filter((id): id is string => Boolean(id) && originalServiceIds.has(id as string)))];
        const lineServices = lineServiceIds.length
          ? await this.serviceRepository.find({where: {id: {inq: lineServiceIds}} as object})
          : [];
        const serviceCategoryByServiceId = new Map(lineServices.map(service => [service.id, service.serviceCategoryId]));
        if (body.itemCategoryEstimate.some(line => (line.itemCategoryId
          ? !isOriginalPair(line) && !(line.serviceId &&
            originalServiceIds.has(line.serviceId) &&
            serviceCategoryByServiceId.get(line.serviceId) === line.itemCategoryId)
          : !originalServiceIds.has(line.serviceId as string)))) {
          throw new HttpErrors.BadRequest('Rework service and item category must belong to the original order.');
        }
      }
      const reworkOrderId = (approval.metadata as Record<string, unknown> | undefined)?.reworkOrderId;
      if (!reworkOrderId && approval.status !== ApprovalRequestStatus.APPROVED) {
        throw new HttpErrors.Conflict('Approve the reprocess request before scheduling its pickup.');
      }
      if (reworkOrderId) {
        const reworkOrder = await this.orderRepository.findOne({where: {id: String(reworkOrderId), isDeleted: false}});
        if (!reworkOrder || reworkOrder.status !== OrderStatus.CONFIRMED) {
          throw new HttpErrors.Conflict('This rework ticket has already been received or completed.');
        }
      }
      const existingPickup = await this.pickupRequestRepository.findOne({where: {
        reworkApprovalRequestId: approval.id,
        isDeleted: false,
        status: {nin: [PickupRequestStatus.CANCELLED, PickupRequestStatus.NOT_SERVICEABLE]},
      } as object});
      if (existingPickup) throw new HttpErrors.Conflict('A pickup for this rework ticket already exists.');
    }

    const {slotId, ...rest} = body;
    const slot = slotId !== undefined ? await this.resolveSlotLabel(slotId) : body.slot;

    const {v4} = await import('uuid');
    const count = await this.pickupRequestRepository.count();
    const pickupNumber = `PU${String(count.count + 1).padStart(6, '0')}`;
    const pickupRequest = await this.pickupRequestService.createRequest({
      id: v4(),
      pickupNumber,
      ...rest,
      slot,
      ...(slotId !== undefined ? {pickupSlotId: slotId} : {}),
      customerCountryCode: body.customerCountryCode?.trim() ? body.customerCountryCode.trim() : '+91',
      status: PickupRequestStatus.REQUESTED,
    });

    if (this.systemNotificationService) {
      if (body.isReworkPickup) {
        const origOrderId = body.reworkOfOrderId;
        const findOrder = origOrderId
          ? this.orderRepository.findOne({where: {id: origOrderId}})
          : Promise.resolve(null);
        findOrder
          .then(origOrder =>
            this.systemNotificationService!.notifyReprocessPickupCreated({
              pickupNumber: pickupRequest.pickupNumber ?? pickupRequest.id,
              orderNumber: origOrder?.orderNumber,
              storeId: pickupRequest.storeId,
              customerName: pickupRequest.customerName,
            }),
          )
          .catch(err => {
            console.error('Failed to notify reprocess pickup created:', err);
          });
      } else {
        this.systemNotificationService
          .notifyCustomerPickupRequested(pickupRequest, pickupRequest.customerName)
          .catch(err => {
            console.error('Failed to notify customer pickup requested:', err);
          });
      }
    }

    return {message: 'Pickup request created.', pickupRequest};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-requests')
  @response(200, {description: 'Pickup requests'})
  async find(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.filter(PickupRequest) filter?: Filter<PickupRequest>,
    // Narrows the caller's token scope down to one store/cluster, same
    // contract as OrderController.listOrders — see StoreScopeService.narrowStoreIds.
    @param.query.string('storeId') storeIdFilter?: string,
    @param.query.string('clusterId') clusterIdFilter?: string,
  ): Promise<object[]> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const storeIds = await this.storeScopeService.narrowStoreIds(scope, {
      storeId: storeIdFilter,
      clusterId: clusterIdFilter,
    });

    const scopeWhere = Array.isArray(storeIds)
      ? pickupScopeWhere(storeIds, !storeIdFilter && !clusterIdFilter)
      : undefined;

    const rawIncludes = filter?.include;
    const filterIncludes = Array.isArray(rawIncludes) ? rawIncludes : [];
    const hasPickupSlotInclude = filterIncludes.some(
      (inc: any) => inc === 'pickupSlot' || inc?.relation === 'pickupSlot',
    );
    const include = hasPickupSlotInclude
      ? filterIncludes
      : [...filterIncludes, {relation: 'pickupSlot'}];

    const requests = await this.pickupRequestRepository.find({
      ...filter,
      include,
      // ANDed, not spread: the scope is an `or`, and spreading it would
      // silently replace an `or` the caller sent in filter.where.
      where: {
        and: [filter?.where, scopeWhere, {isDeleted: false}].filter(
          (clause): clause is object => !!clause && Object.keys(clause).length > 0,
        ),
      } as object,
      order: filter?.order ?? ['createdAt DESC'],
    });
    return this.enrichWithReworkOrderNumber(await this.enrichWithSuggestedRider(requests));
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-requests/count')
  @response(200, {description: 'Pickup request count'})
  async count(@param.query.object('where') where?: object): Promise<{count: number}> {
    return this.pickupRequestRepository.count({...where, isDeleted: false} as object);
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-requests/{id}')
  @response(200, {
    description: 'One pickup request with bag numbers, media URLs, and service names',
    content: {'application/json': {schema: {
      allOf: [
        getModelSchemaRef(PickupRequest, {includeRelations: true}),
        {type: 'object', properties: {
          suggestedRiderId: {type: 'string', nullable: true},
          suggestedRiderName: {type: 'string', nullable: true},
          reworkOfOrderNumber: {type: 'string', nullable: true},
          convertedOrderNumber: {type: 'string', nullable: true},
          convertedOrderNumbers: {type: 'array', items: {type: 'string'}},
          bagNumber: {type: 'number', nullable: true},
          bagNumbers: {type: 'array', items: {type: 'number'}},
          mediaUrls: {type: 'array', items: {type: 'string'}},
          riderMediaUrls: {type: 'array', items: {type: 'string'}},
          storeReceipt: {
            type: 'object',
            nullable: true,
            description: 'Rider-to-store handover once the store confirmed receipt; null before that.',
            properties: {
              handoverNumber: {type: 'string'},
              riderName: {type: 'string'},
              riderCode: {type: 'string'},
              receivedByName: {type: 'string', nullable: true},
              receivedAt: {type: 'string', format: 'date-time', nullable: true},
            },
          },
          itemCategoryEstimate: {type: 'array', items: {type: 'object', properties: {
            itemCategoryName: {type: 'string', nullable: true},
            serviceName: {type: 'string', nullable: true},
          }}},
          actualItemsByService: {type: 'array', items: {type: 'object', properties: {
            serviceName: {type: 'string', nullable: true},
            serviceCategoryId: {type: 'string', nullable: true},
            serviceCategoryName: {type: 'string', nullable: true},
            bagNumber: {type: 'number', nullable: true},
            mediaUrls: {type: 'array', items: {type: 'string'}},
          }}},
        }},
      ],
    }}},
  })
  async findById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const pickupRequest = await this.pickupRequestRepository.findOne({
      where: {id, isDeleted: false},
      include: [
        {relation: 'assignedRider'},
        {relation: 'customer'},
        {relation: 'store'},
        {relation: 'pickupSlot'},
      ],
    });
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    const scope = await this.storeScopeService.resolve(currentUser);
    this.assertPickupScopeVisible(scope, pickupRequest);

    const bagIds = [...new Set([
      pickupRequest.bagId,
      ...(pickupRequest.actualItemsByService ?? []).map(line => line.bagId),
    ].filter((bagId): bagId is string => Boolean(bagId)))];
    const convertedOrderIds = [...new Set([
      pickupRequest.convertedOrderId,
      ...Object.values(pickupRequest.convertedOrders ?? {}),
    ].filter((orderId): orderId is string => Boolean(orderId)))];
    const escalations = await this.pickupEscalationRepository.find({
      where: {pickupRequestId: id, isDeleted: false} as object,
      fields: {mediaIds: true} as object,
    });
    const riderMediaIds = [...new Set([
      ...(pickupRequest.actualItemsByService ?? []).flatMap(line => line.mediaIds ?? []),
      ...escalations.flatMap(escalation => escalation.mediaIds ?? []),
    ])];
    const mediaIds = [...new Set([
      ...(pickupRequest.mediaIds ?? []),
      ...riderMediaIds,
    ])];
    const itemCategoryIds = [...new Set((pickupRequest.itemCategoryEstimate ?? []).map(line => line.itemCategoryId).filter(Boolean))];
    const serviceIds = [...new Set([
      ...(pickupRequest.itemCategoryEstimate ?? []).map(line => line.serviceId),
      ...(pickupRequest.actualItemsByService ?? []).map(line => line.serviceId),
    ].filter((id): id is string => Boolean(id)))];

    const [bags, media, itemCategories, services, convertedOrders, enriched, storeReceipt] = await Promise.all([
      bagIds.length ? this.bagRepository.find({where: {id: {inq: bagIds}} as object}) : [],
      mediaIds.length ? this.mediaRepository.find({where: {id: {inq: mediaIds}} as object}) : [],
      itemCategoryIds.length ? this.itemCategoryRepository.find({where: {id: {inq: itemCategoryIds}} as object}) : [],
      serviceIds.length ? this.serviceRepository.find({where: {id: {inq: serviceIds}} as object}) : [],
      convertedOrderIds.length
        ? this.orderRepository.find({where: {id: {inq: convertedOrderIds}} as object, fields: {id: true, orderNumber: true} as object})
        : [],
      this.enrichWithSuggestedRider([pickupRequest]).then(requests => this.enrichWithReworkOrderNumber(requests)),
      this.storeReceiptFor(id),
    ]);
    const bagNumberById = new Map(bags.map(bag => [bag.id, bag.bagNumber]));
    const convertedOrderNumberById = new Map(convertedOrders.map(order => [order.id, order.orderNumber]));
    const mediaUrlById = new Map(media.map(file => [file.id, file.fileUrl]));
    const itemCategoryNameById = new Map(itemCategories.map(category => [category.id, category.name]));
    const serviceNameById = new Map(services.map(service => [service.id, service.name]));
    const serviceCategoryIds = [...new Set(services.map(service => service.serviceCategoryId).filter((id): id is string => Boolean(id)))];
    const serviceCategories = serviceCategoryIds.length
      ? await this.serviceCategoryRepository.find({where: {id: {inq: serviceCategoryIds}} as object})
      : [];
    const serviceCategoryNameById = new Map(serviceCategories.map(category => [category.id, category.name]));
    const serviceCategoryIdByServiceId = new Map(services.map(service => [service.id, service.serviceCategoryId]));
    const toUrls = (ids?: string[]) => (ids ?? []).map(id => mediaUrlById.get(id)).filter((url): url is string => Boolean(url));

    return {
      ...enriched[0],
      storeReceipt,
      convertedOrderNumber: pickupRequest.convertedOrderId
        ? convertedOrderNumberById.get(pickupRequest.convertedOrderId) ?? null : null,
      convertedOrderNumbers: convertedOrderIds
        .map(orderId => convertedOrderNumberById.get(orderId))
        .filter((number): number is string => number !== undefined),
      bagNumber: pickupRequest.bagId ? bagNumberById.get(pickupRequest.bagId) ?? null : null,
      bagNumbers: bagIds
        .map(bagId => bagNumberById.get(bagId))
        .filter((number): number is number => number !== undefined),
      mediaUrls: toUrls(pickupRequest.mediaIds),
      riderMediaUrls: toUrls(riderMediaIds),
      itemCategoryEstimate: (pickupRequest.itemCategoryEstimate ?? []).map(line => ({
        ...line,
        itemCategoryName: line.itemCategoryName ?? itemCategoryNameById.get(line.itemCategoryId) ?? null,
        serviceName: line.serviceName ?? (line.serviceId ? serviceNameById.get(line.serviceId) ?? null : null),
      })),
      actualItemsByService: (pickupRequest.actualItemsByService ?? []).map(line => {
        const serviceCategoryId = serviceCategoryIdByServiceId.get(line.serviceId);
        return {
          ...line,
          serviceName: line.serviceName ?? serviceNameById.get(line.serviceId) ?? null,
          serviceCategoryId: serviceCategoryId ?? null,
          serviceCategoryName: serviceCategoryId ? serviceCategoryNameById.get(serviceCategoryId) ?? null : null,
          bagNumber: line.bagId ? bagNumberById.get(line.bagId) ?? null : null,
          mediaUrls: toUrls(line.mediaIds),
        };
      }),
    };
  }

  /**
   * Who handed this pickup's bag to the store and who received it — the
   * latest confirmed store-bound PickupHandover (POST /pickup-handovers/{id}/confirm)
   * that contains this pickup. Null until a store confirms one; a pickup a
   * rider marked received_at_store directly has no handover record.
   */
  private async storeReceiptFor(pickupRequestId: string): Promise<{
    handoverNumber: string;
    riderName: string;
    riderCode: string;
    receivedByName: string | null;
    receivedAt: Date | null;
  } | null> {
    const rows = (await this.dataSource.execute(
      `SELECT h.handovernumber, h.ridername, h.ridercode, h.confirmedat, u.fullname AS receivedbyname
       FROM public.pickup_handover_item i
       JOIN public.pickup_handover h ON h.id = i.pickuphandoverid
       LEFT JOIN public.users u ON u.id::text = h.confirmedby::text
       WHERE i.pickuprequestid = $1
         AND h.isdeleted = false
         AND h.status = 'confirmed'
         AND coalesce(h.handovertotype, 'store') = 'store'
       ORDER BY h.confirmedat DESC NULLS LAST
       LIMIT 1`,
      [pickupRequestId],
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    return {
      handoverNumber: String(row.handovernumber),
      riderName: String(row.ridername),
      riderCode: String(row.ridercode),
      receivedByName: (row.receivedbyname as string | null) ?? null,
      receivedAt: (row.confirmedat as Date | null) ?? null,
    };
  }

  // ─── Update (details + status transitions) ─────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @patch('/pickup-requests/{id}')
  @response(200, {description: 'Pickup request updated'})
  async updateById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              customerName: {type: 'string'},
              customerCountryCode: {type: 'string'},
              customerMobile: {type: 'string'},
              address: {type: 'string'},
              pincode: {type: 'string'},
              requestedDate: {type: 'string', format: 'date'},
              slot: {type: 'string'},
              storeId: {type: 'string', format: 'uuid'},
              itemCountEstimate: {type: 'number'},
              remarks: {type: 'string'},
              status: {type: 'string', enum: Object.values(PickupRequestStatus)},
              convertedOrderId: {type: 'string', format: 'uuid'},
              deliverySpeed: {type: 'string', enum: Object.values(DeliveryType)},
              cancellationReason: {
                type: 'string',
                enum: Object.values(PickupCancellationReason),
                description: 'Required when status is cancelled — why the pickup was cancelled.',
              },
              cancellationOtherReason: {
                type: 'string',
                description: 'Required when cancellationReason is "other" — the free-text reason.',
              },
            },
          },
        },
      },
    })
    body: UpdateBody,
  ): Promise<object> {
    const existing = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pickup request not found.');
    const scope = await this.storeScopeService.resolve(currentUser);
    this.assertPickupScopeVisible(scope, existing);

    const {status, convertedOrderId, deliverySpeed, cancellationReason, cancellationOtherReason, ...rest} =
      body;
    if (status !== undefined && status !== existing.status) {
      this.assertTransition(existing.status ?? PickupRequestStatus.REQUESTED, status);
    }

    // A cancellation now requires a reason — one predefined code, plus a
    // free-text note when that code is "other". Captured only on the
    // transition INTO cancelled (re-saving an already-cancelled pickup
    // doesn't demand it again).
    const isCancelling =
      status === PickupRequestStatus.CANCELLED && existing.status !== PickupRequestStatus.CANCELLED;
    if (isCancelling) {
      if (!cancellationReason?.trim()) {
        throw new HttpErrors.BadRequest('A cancellation reason is required to cancel a pickup.');
      }
      if (!Object.values(PickupCancellationReason).includes(cancellationReason as PickupCancellationReason)) {
        throw new HttpErrors.BadRequest('Invalid cancellation reason.');
      }
      if (cancellationReason === PickupCancellationReason.OTHER && !cancellationOtherReason?.trim()) {
        throw new HttpErrors.BadRequest('Please describe the cancellation reason.');
      }
    }
    if (rest.storeId !== undefined && rest.storeId !== existing.storeId) {
      await this.assertProcessingStoreChangeable(existing, rest.storeId, scope);
    }

    if (convertedOrderId !== undefined) {
      if (deliverySpeed) {
        const items = existing.actualItemsByService?.length
          ? existing.actualItemsByService
          : existing.itemCategoryEstimate ?? [];
        const requested = items.length
          ? items.map(item => item.deliverySpeed ?? DeliveryType.STANDARD)
          : [DeliveryType.STANDARD];
        // shortcut: simultaneous staff links can race; use an atomic update if concurrent conversion is required.
        const next = [DeliveryType.LIGHTNING, DeliveryType.EXPRESS, DeliveryType.STANDARD]
          .filter(speed => requested.includes(speed))
          .find((speed, index) => !existing.convertedOrders?.[speed] && !(index === 0 && existing.convertedOrderId));
        if (deliverySpeed !== next) {
          throw new HttpErrors.Conflict('This delivery type is not the next order for this pickup request.');
        }
      } else if (existing.convertedOrderId) {
        throw new HttpErrors.Conflict('This pickup request has already been converted to an order.');
      }
      const order = await this.orderRepository.findOne({where: {id: convertedOrderId, isDeleted: false}});
      if (!order) throw new HttpErrors.NotFound('Order not found.');
      // Denormalized at the moment the link is made, same convention as
      // assignedRiderName next to assignedRiderId — a home_pickup* order's
      // originating channel is always this pickup's own source, resolved
      // here rather than trusted from the client.
      await this.orderRepository.updateById(convertedOrderId, {
        pickupRequestId: id,
        ...(existing.source ? {pickupSource: existing.source} : {}),
      });
    }

    await this.pickupRequestRepository.updateById(id, {
      ...rest,
      ...(status !== undefined ? {status} : {}),
      ...(isCancelling
        ? {
            cancellationReason,
            cancellationOtherReason:
              cancellationReason === PickupCancellationReason.OTHER
                ? cancellationOtherReason!.trim()
                : (null as unknown as string),
            cancelledAt: new Date(),
            cancelledBy: currentUser[securityId],
          }
        : {}),
      ...(convertedOrderId !== undefined && !existing.convertedOrderId ? {convertedOrderId} : {}),
      ...(convertedOrderId !== undefined && deliverySpeed
        ? {convertedOrders: {...existing.convertedOrders, [deliverySpeed]: convertedOrderId}}
        : {}),
    });

    if (
      status === PickupRequestStatus.CANCELLED &&
      existing.status !== PickupRequestStatus.CANCELLED &&
      existing.assignedRiderId
    ) {
      // Not awaited — a slow/unreachable FCM call must never delay this
      // response. notifyRider() already swallows its own errors, but
      // .catch() is cheap insurance against an unhandled rejection.
      this.notificationService
        .notifyRider(existing.assignedRiderId, {
          type: RIDER_NOTIFICATION_TYPES.PICKUP_CANCELLED,
          title: 'Pickup cancelled',
          body: `The pickup at ${existing.pincode ?? 'the customer address'} has been cancelled.`,
          data: {pickupRequestId: id},
        })
        .catch(() => {});
    }

    if (status === PickupRequestStatus.PICKED_UP && existing.status !== status) {
      this.pickupRequestService.notifyPickedUp(id);
    }
    return {message: 'Pickup request updated.'};
  }

  // ─── Soft delete ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:delete']})
  @del('/pickup-requests/{id}')
  @response(200, {description: 'Pickup request deleted'})
  async deleteById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const existing = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pickup request not found.');
    const scope = await this.storeScopeService.resolve(currentUser);
    this.assertPickupScopeVisible(scope, existing);

    const inFlight =
      existing.status !== PickupRequestStatus.REQUESTED &&
      existing.status !== PickupRequestStatus.SCHEDULED &&
      existing.status !== PickupRequestStatus.CANCELLED;
    if (inFlight) {
      throw new HttpErrors.BadRequest(
        `Cannot delete a pickup request that is already ${existing.status}.`,
      );
    }

    await this.pickupRequestRepository.updateById(id, {
      isDeleted: true,
      deletedAt: new Date() as unknown as Date,
    });
    return {message: 'Pickup request deleted.'};
  }

  // ─── Bulk-assign to a rider (one trip, many pickups) ───────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @post('/pickup-requests/assign')
  @response(200, {description: 'Pickup requests assigned to a rider'})
  async assign(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['pickupRequestIds', 'riderId', 'storeId', 'scheduledDate', 'slot'],
            properties: {
              pickupRequestIds: {type: 'array', minItems: 1, items: {type: 'string', format: 'uuid'}},
              riderId: {type: 'string', format: 'uuid'},
              storeId: {type: 'string', format: 'uuid'},
              scheduledDate: {type: 'string', format: 'date'},
              slot: {type: 'string'},
              slotId: {
                type: 'string',
                format: 'uuid',
                description: 'If given, overrides slot with this slot\'s label.',
              },
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {
      pickupRequestIds: string[];
      riderId: string;
      storeId: string;
      scheduledDate: string;
      slot: string;
      slotId?: string;
      remarks?: string;
    },
  ): Promise<object> {
    const rider = await this.assertRiderAssignable(body.riderId);
    // Roster is the only availability gate now — a rider with other active
    // pickups/deliveries is assignable without limit; only their roster for
    // this specific job's own scheduled window (not "right now") blocks it.
    const slotWindow = await this.riderAssignmentService.resolveSlotWindow(body.scheduledDate, body.slotId);
    await this.riderAssignmentService.assertRiderRostered(body.riderId, slotWindow);
    const store = await this.storeRepository.findOne({where: {id: body.storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const slot = body.slotId !== undefined ? await this.resolveSlotLabel(body.slotId) : body.slot;

    const requests = await this.pickupRequestRepository.find({
      where: {id: {inq: body.pickupRequestIds}, isDeleted: false} as object,
    });
    if (requests.length !== body.pickupRequestIds.length) {
      throw new HttpErrors.NotFound('One or more pickup requests were not found.');
    }
    // Also reassignable once a rider is already on it (rider_assigned) or
    // has set off (out_for_pickup) — the admin panel's own "Change Rider"
    // action targets exactly those two statuses (see
    // REASSIGNABLE_STATUSES in pickup-management-view.js) and calls this
    // same endpoint, so rejecting them here made every reassignment
    // attempt fail with "already rider_assigned/out_for_pickup". Still
    // blocked once the pickup is actually done (arrived/picked up/at
    // store) or terminal (unsuccessful/cancelled/not serviceable) — there's
    // no rider left to reassign away from at that point.
    const notAssignable = requests.filter(
      r =>
        r.status !== PickupRequestStatus.REQUESTED &&
        r.status !== PickupRequestStatus.SCHEDULED &&
        r.status !== PickupRequestStatus.RIDER_ASSIGNED &&
        r.status !== PickupRequestStatus.OUT_FOR_PICKUP,
    );
    if (notAssignable.length) {
      throw new HttpErrors.BadRequest(
        `Pickup request(s) already ${notAssignable.map(r => r.status).join(', ')} cannot be assigned.`,
      );
    }
    // Only riders mapped to a request's pincode may be assigned to it.
    for (const req of requests) {
      await this.riderAssignmentService.assertRiderCoversPincode(body.riderId, req.pincode);
    }

    const {v4} = await import('uuid');
    const runId = v4();
    const now = new Date();
    // No separate PickupRun table to count against, so count distinct runIds
    // already on record instead — same "RUN{seq6}" shape as PU/ORD numbers,
    // just sourced from a raw query instead of repository.count().
    const distinctRuns = await this.dataSource.execute(
      'SELECT COUNT(DISTINCT runid) AS count FROM pickup_request WHERE runid IS NOT NULL',
    );
    const runSeq = Number(distinctRuns?.[0]?.count ?? 0) + 1;
    const runNumber = `RUN${String(runSeq).padStart(6, '0')}`;
    const assignedRiderName = `${rider.firstName} ${rider.lastName}`;

    await this.pickupRequestService.assignRiders(
      requests,
      {
        assignedRiderId: body.riderId,
        assignedRiderName,
        assignedAt: now,
        assignedBy: currentUser[securityId],
        storeId: body.storeId,
        requestedDate: body.scheduledDate,
        slot,
        ...(body.slotId !== undefined ? {pickupSlotId: body.slotId} : {}),
        status: PickupRequestStatus.RIDER_ASSIGNED,
        runId,
        runNumber,
        ...(body.remarks ? {remarks: body.remarks} : {}),
      },
    );

    // Not awaited — notifications never block or roll back the assignment
    // itself. NotificationService.notifyRider already swallows its own
    // errors; .catch() here is cheap insurance against an unhandled
    // rejection. The rider actually getting the work matters regardless of
    // whether the push succeeds, and it must not delay this response.
    const previousRiderIds = new Set(
      requests
        .map(r => r.assignedRiderId)
        .filter((riderId): riderId is string => Boolean(riderId) && riderId !== body.riderId),
    );
    Promise.all([
      this.notificationService.notifyRider(body.riderId, {
        type: RIDER_NOTIFICATION_TYPES.PICKUP_ASSIGNED,
        title: 'New pickup assigned',
        body:
          requests.length > 1
            ? `${requests.length} pickups assigned to you for ${body.scheduledDate}.`
            : `A pickup at ${requests[0].pincode ?? 'the customer address'} has been assigned to you.`,
        data: {runId, runNumber, pickupRequestIds: body.pickupRequestIds.join(',')},
      }),
      ...[...previousRiderIds].map(oldRiderId =>
        this.notificationService.notifyRider(oldRiderId, {
          type: RIDER_NOTIFICATION_TYPES.PICKUP_REASSIGNED,
          title: 'Pickup reassigned',
          body: 'A pickup previously assigned to you has been reassigned to another rider.',
          data: {runId, runNumber},
        }),
      ),
    ]).catch(() => {});

    return {message: 'Pickup requests assigned.', runId, runNumber, assignedCount: requests.length};
  }
}
