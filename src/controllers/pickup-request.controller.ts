import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {Filter, IsolationLevel, repository} from '@loopback/repository';
import {del, get, getModelSchemaRef, HttpErrors, param, patch, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {PickupRequest} from '../models';
import {RiderPincodeMappingWithRelations} from '../models/rider-pincode-mapping.model';
import {PickupRequestSource} from '../models/pickup-request-source.enum';
import {PICKUP_REQUEST_STATUS_TRANSITIONS, PickupRequestStatus} from '../models/pickup-request-status.enum';
import {
  CustomerRepository,
  PickupDeliverySlotRepository,
  PickupRequestRepository,
  RiderPincodeMappingRepository,
  RiderRepository,
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
  remarks?: string;
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
}

export class PickupRequestController {
  constructor(
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
    @repository(RiderPincodeMappingRepository)
    private riderPincodeMappingRepository: RiderPincodeMappingRepository,
    @inject('datasources.pressto')
    private dataSource: PresstoDataSource,
  ) {}

  // ─── Validation helpers ───────────────────────────────────────────────────

  private assertTransition(current: PickupRequestStatus, next: PickupRequestStatus) {
    const allowed = PICKUP_REQUEST_STATUS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new HttpErrors.BadRequest(`Cannot move a pickup request from ${current} to ${next}.`);
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
              remarks: {type: 'string'},
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

    const {slotId, ...rest} = body;
    const slot = slotId !== undefined ? await this.resolveSlotLabel(slotId) : body.slot;

    const {v4} = await import('uuid');
    const count = await this.pickupRequestRepository.count();
    const pickupNumber = `PU${String(count.count + 1).padStart(6, '0')}`;
    const pickupRequest = await this.pickupRequestRepository.create({
      id: v4(),
      pickupNumber,
      ...rest,
      slot,
      ...(slotId !== undefined ? {pickupSlotId: slotId} : {}),
      customerCountryCode: body.customerCountryCode?.trim() ? body.customerCountryCode.trim() : '+91',
      status: PickupRequestStatus.REQUESTED,
    });
    return {message: 'Pickup request created.', pickupRequest};
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-requests')
  @response(200, {description: 'Pickup requests'})
  async find(@param.filter(PickupRequest) filter?: Filter<PickupRequest>): Promise<object[]> {
    const requests = await this.pickupRequestRepository.find({
      ...filter,
      where: {...filter?.where, isDeleted: false},
      order: filter?.order ?? ['createdAt DESC'],
    });
    return this.enrichWithSuggestedRider(requests);
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
    description: 'One pickup request',
    content: {'application/json': {schema: getModelSchemaRef(PickupRequest, {includeRelations: true})}},
  })
  async findById(@param.path.string('id') id: string): Promise<PickupRequest> {
    const pickupRequest = await this.pickupRequestRepository.findOne({
      where: {id, isDeleted: false},
      include: [{relation: 'assignedRider'}, {relation: 'customer'}, {relation: 'store'}],
    });
    if (!pickupRequest) throw new HttpErrors.NotFound('Pickup request not found.');
    return pickupRequest;
  }

  // ─── Update (details + status transitions) ─────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @patch('/pickup-requests/{id}')
  @response(200, {description: 'Pickup request updated'})
  async updateById(
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
            },
          },
        },
      },
    })
    body: UpdateBody,
  ): Promise<object> {
    const existing = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pickup request not found.');

    const {status, ...rest} = body;
    if (status !== undefined && status !== existing.status) {
      this.assertTransition(existing.status ?? PickupRequestStatus.REQUESTED, status);
    }

    await this.pickupRequestRepository.updateById(id, {
      ...rest,
      ...(status !== undefined ? {status} : {}),
    });
    return {message: 'Pickup request updated.'};
  }

  // ─── Soft delete ────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:delete']})
  @del('/pickup-requests/{id}')
  @response(200, {description: 'Pickup request deleted'})
  async deleteById(@param.path.string('id') id: string): Promise<object> {
    const existing = await this.pickupRequestRepository.findOne({where: {id, isDeleted: false}});
    if (!existing) throw new HttpErrors.NotFound('Pickup request not found.');

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
    const store = await this.storeRepository.findOne({where: {id: body.storeId}});
    if (!store) throw new HttpErrors.NotFound('Store not found.');

    const slot = body.slotId !== undefined ? await this.resolveSlotLabel(body.slotId) : body.slot;

    const requests = await this.pickupRequestRepository.find({
      where: {id: {inq: body.pickupRequestIds}, isDeleted: false} as object,
    });
    if (requests.length !== body.pickupRequestIds.length) {
      throw new HttpErrors.NotFound('One or more pickup requests were not found.');
    }
    const notAssignable = requests.filter(
      r => r.status !== PickupRequestStatus.REQUESTED && r.status !== PickupRequestStatus.SCHEDULED,
    );
    if (notAssignable.length) {
      throw new HttpErrors.BadRequest(
        `Pickup request(s) already ${notAssignable.map(r => r.status).join(', ')} cannot be assigned.`,
      );
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

    const tx = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      for (const req of requests) {
        await this.pickupRequestRepository.updateById(
          req.id,
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
          {transaction: tx},
        );
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    return {message: 'Pickup requests assigned.', runId, runNumber, assignedCount: requests.length};
  }
}
