import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {TransferCustodyEventType} from '../models/transfer-custody-event-type.enum';
import {TransferStatus} from '../models/transfer-status.enum';
import {
  BagRepository,
  RiderRepository,
  TransferCustodyEventRepository,
  TransferItemRepository,
  TransferRepository,
} from '../repositories';

/**
 * Rider-facing inter-store transfer APIs — the rider's own leg of a bag
 * moving between stores. A store admin assigns a rider to a transfer (see
 * TransferController.assignRider, POST /transfers/{id}/assign-rider); the
 * rider then marks themself in transit here. The destination store's own
 * receive() call (POST /transfers/{id}/receive) is what completes the
 * rider's leg — there is no separate "delivered" action here, matching how
 * a customer delivery's payment-capture step is the rider's own completion
 * action but here the destination store does the equivalent verification.
 * Role-gated (roles: ['rider']), same posture as rider-pickup/rider-delivery.
 */
export class RiderTransferController {
  constructor(
    @repository(RiderRepository) private riderRepository: RiderRepository,
    @repository(TransferRepository) private transferRepository: TransferRepository,
    @repository(TransferItemRepository) private transferItemRepository: TransferItemRepository,
    @repository(TransferCustodyEventRepository)
    private custodyEventRepository: TransferCustodyEventRepository,
    @repository(BagRepository) private bagRepository: BagRepository,
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

  // ─── The rider's own assigned transfers ──────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/transfers')
  @response(200, {description: "The calling rider's own transfers"})
  async myTransfers(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    // Exact status, when a caller wants one specific bucket by name —
    // takes priority over tab when both are sent, though callers should
    // only ever send one.
    @param.query.string('status') status?: TransferStatus,
    // The app's two tabs, as buckets of statuses rather than one exact
    // value — same shape as GET /rider/pickup-requests?tab=. Pending: the
    // rider still has the bag. Completed: the destination store has
    // already acted on it — received cleanly or flagged a discrepancy,
    // either way the rider's own leg is done. Omitting both (or
    // tab=pending) is Pending — the original default.
    @param.query.string('tab') tab?: 'pending' | 'completed',
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);

    let statusWhere: object;
    if (status) {
      statusWhere = {status};
    } else if (tab === 'completed') {
      statusWhere = {
        status: {inq: [TransferStatus.RECEIVED, TransferStatus.DISCREPANCY, TransferStatus.RESOLVED]},
      };
    } else {
      statusWhere = {status: {inq: [TransferStatus.RIDER_ASSIGNED, TransferStatus.IN_TRANSIT]}};
    }

    const transfers = await this.transferRepository.find({
      where: {
        riderId: rider.id,
        isDeleted: false,
        ...statusWhere,
      } as object,
      order: ['riderAssignedAt DESC'],
    });
    return {transfers};
  }

  // ─── Transfer detail ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @get('/rider/transfers/{id}')
  @response(200, {description: 'Transfer detail with the items in the bag'})
  async transferDetail(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    // Accept either the real uuid or the human-readable transitId, same
    // dual-lookup posture as the admin GET /transfers/{id} — a non-uuid
    // value resolves cleanly instead of Postgres throwing on a malformed
    // uuid literal.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(id.trim());
    const transfer = await this.transferRepository.findOne({
      where: isUuid ? {id, isDeleted: false} : {transitId: id.trim(), isDeleted: false},
    });
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This transfer is not assigned to you.');
    }

    const items = await this.transferItemRepository.find({where: {transferId: transfer.id} as object});

    // Every bag the rider must scan before starting transit (see startTransit
    // below) — resolved here with real bag numbers so the app has something
    // scannable to check off, not just uuids.
    const bagIds = [...new Set(items.map(i => i.bagId ?? transfer.bagId).filter(Boolean))];
    if (transfer.bagId) bagIds.push(transfer.bagId);
    const uniqueBagIds = [...new Set(bagIds)];
    const bags = uniqueBagIds.length
      ? await this.bagRepository.find({where: {id: {inq: uniqueBagIds}} as object})
      : [];

    return {
      transfer,
      items,
      bags: bags.map(b => ({id: b.id, bagNumber: b.bagNumber})),
    };
  }

  // ─── Mark in transit ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @patch('/rider/transfers/{id}/status')
  @response(200, {description: 'Transfer marked in transit'})
  async startTransit(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status', 'bagIds'],
            properties: {
              status: {type: 'string', enum: [TransferStatus.IN_TRANSIT]},
              bagIds: {
                type: 'array',
                items: {type: 'string', format: 'uuid'},
                description:
                  'Every bag belonging to this transfer, scanned by the rider before pickup — ' +
                  'must exactly cover the transfer\'s full bag set or the status change is rejected.',
              },
            },
          },
        },
      },
    })
    body: {status: TransferStatus; bagIds: string[]},
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);
    const transfer = await this.transferRepository.findOne({where: {id, isDeleted: false}});
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This transfer is not assigned to you.');
    }
    if (body.status !== TransferStatus.IN_TRANSIT) {
      throw new HttpErrors.BadRequest(`Riders can only set status to ${TransferStatus.IN_TRANSIT}.`);
    }
    if (transfer.status !== TransferStatus.RIDER_ASSIGNED) {
      throw new HttpErrors.BadRequest(`Cannot start transit on a transfer that is ${transfer.status}, not rider_assigned.`);
    }

    // Every bag in the transfer must be scanned before the rider can start
    // transit — items written before multi-bag transfers existed have no
    // bagId of their own and fall back to the transfer's own primary bagId.
    const items = await this.transferItemRepository.find({where: {transferId: id} as object});
    const expectedBagIds = new Set(items.map(i => i.bagId ?? transfer.bagId).filter(Boolean));
    if (transfer.bagId) expectedBagIds.add(transfer.bagId);
    const scannedBagIds = new Set(body.bagIds);
    const missing = [...expectedBagIds].filter(bagId => !scannedBagIds.has(bagId));
    if (missing.length) {
      const bags = await this.bagRepository.find({where: {id: {inq: missing}} as object});
      const labels = bags.map(b => b.bagNumber).join(', ') || `${missing.length} bag(s)`;
      throw new HttpErrors.BadRequest(`Scan every bag in this transfer before starting transit — still missing: ${labels}.`);
    }

    await this.transferRepository.updateById(id, {
      status: TransferStatus.IN_TRANSIT,
      inTransitAt: new Date(),
      inTransitBy: currentUser[securityId],
    });

    const {v4} = await import('uuid');
    for (const bagId of expectedBagIds) {
      await this.custodyEventRepository.create({
        id: v4(),
        transferId: id,
        eventType: TransferCustodyEventType.BAG_SCANNED,
        bagId,
        performedBy: currentUser[securityId],
      });
    }
    await this.custodyEventRepository.create({
      id: v4(),
      transferId: id,
      eventType: TransferCustodyEventType.IN_TRANSIT,
      performedBy: currentUser[securityId],
    });

    return {message: 'Transfer marked in transit.'};
  }
}
