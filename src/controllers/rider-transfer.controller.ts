import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {IsolationLevel, repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PresstoDataSource} from '../datasources';
import {Transfer} from '../models';
import {TransferCustodyEventType} from '../models/transfer-custody-event-type.enum';
import {TransferItemScanStatus} from '../models/transfer-item-status.enum';
import {TransferStatus} from '../models/transfer-status.enum';
import {
  BagRepository,
  RiderRepository,
  StoreRepository,
  TransferCustodyEventRepository,
  TransferItemRepository,
  TransferRepository,
} from '../repositories';
import {StoreCoordinates, StoreLocationService} from '../services/store-location.service';

export type CountVerificationStatus = 'matched' | 'short' | 'excess';

type StatusUpdateBody = {
  status: TransferStatus;
  bagIds?: string[] | null;
  itemCount?: number | null;
  deliveredItemCount?: unknown;
  discrepancyReason?: unknown;
};

// The INTEGER column's limit: a larger count is rejected as a 400 instead of
// failing in Postgres as a 500.
const MAX_ITEM_COUNT = 2147483647;

/** deliveredItemCount vs the dispatched baseline. */
export function compareItemCounts(expectedItemCount: number, deliveredItemCount: number) {
  const difference = deliveredItemCount - expectedItemCount;
  const countVerificationStatus: CountVerificationStatus =
    difference === 0 ? 'matched' : difference < 0 ? 'short' : 'excess';
  return {expectedItemCount, deliveredItemCount, difference, countVerificationStatus};
}

/**
 * Rider-facing inter-store transfer APIs — the rider's own leg of a bag
 * moving between stores. A store admin assigns a rider to a transfer (see
 * TransferController.assignRider, POST /transfers/{id}/assign-rider); the
 * rider then marks themself in transit, and on arrival marks the transfer
 * delivered with the number of items they handed over. The destination
 * store's receive() (POST /transfers/{id}/receive) then does the item-level
 * verification and any inventory reconciliation; it accepts both delivered
 * and in_transit transfers, so rider apps without the delivery step still work.
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
    @repository(StoreRepository) private storeRepository: StoreRepository,
    @inject('datasources.pressto') private dataSource: PresstoDataSource,
    @inject('services.store-location') private storeLocationService: StoreLocationService,
  ) {}

  /**
   * id/name/pincode/latitude/longitude/coordinateSource per store. Coordinates
   * fall back to the store's PIN code (StoreLocationService); a store that
   * can't be located gets nulls without affecting any other store or transfer.
   */
  private async storeLocations(storeIds: string[]) {
    const ids = [...new Set(storeIds.filter(Boolean))];
    const stores = ids.length
      ? await this.storeRepository.find({
          where: {id: {inq: ids}, isDeleted: false} as object,
          fields: {id: true, name: true, pincode: true, latitude: true, longitude: true} as object,
        })
      : [];
    const coordinates = await this.storeLocationService.resolveCoordinates(stores);
    const byId = new Map<string, {id: string; name: string | null} & StoreCoordinates>(
      stores.map((store, i) => [store.id, {id: store.id, name: store.name, ...coordinates[i]}]),
    );
    return (storeId: string) =>
      byId.get(storeId) ?? {
        id: storeId,
        name: null,
        pincode: null,
        latitude: null,
        longitude: null,
        coordinateSource: null,
      };
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  private async resolveActiveRider(currentUser: UserProfile) {
    const rider = await this.riderRepository.findOne({
      where: {userId: currentUser[securityId], isDeleted: false},
    });
    if (!rider) throw new HttpErrors.Forbidden('This account is not registered as a rider.');
    if (!rider.isActive) throw new HttpErrors.Forbidden('This rider account is inactive.');
    return rider;
  }

  private findTransfer(identifier: string) {
    const value = identifier.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    return this.transferRepository.findOne({
      where: isUuid ? {id: value, isDeleted: false} : {transitId: value, isDeleted: false},
    });
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
    // tab=pending) is Pending — the original default. Delivered (handed
    // over, awaiting the store) also counts as the rider's leg done.
    @param.query.string('tab') tab?: 'pending' | 'completed',
  ): Promise<object> {
    const rider = await this.resolveActiveRider(currentUser);

    let statusWhere: object;
    if (status) {
      statusWhere = {status};
    } else if (tab === 'completed') {
      statusWhere = {
        status: {
          inq: [
            TransferStatus.DELIVERED,
            TransferStatus.RECEIVED,
            TransferStatus.DISCREPANCY,
            TransferStatus.RESOLVED,
          ],
        },
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
      limit: 100,
    });
    const bagIdsByTransfer = new Map(transfers.map(transfer => [transfer.id, new Set<string>()]));
    const items = transfers.length
      ? await this.transferItemRepository.find({
          where: {transferId: {inq: transfers.map(transfer => transfer.id)}} as object,
          fields: {transferId: true, bagId: true} as object,
        })
      : [];
    for (const item of items) {
      const bagIds = bagIdsByTransfer.get(item.transferId);
      if (item.bagId) bagIds?.add(item.bagId);
    }
    const bagIds = [...new Set([
      ...transfers.map(transfer => transfer.bagId),
      ...[...bagIdsByTransfer.values()].flatMap(ids => [...ids]),
    ])];
    const bags = bagIds.length
      ? await this.bagRepository.find({where: {id: {inq: bagIds}} as object})
      : [];
    const bagNumbers = new Map(bags.map(bag => [bag.id, bag.bagNumber]));
    const storeLocation = await this.storeLocations(
      transfers.flatMap(transfer => [transfer.fromStoreId, transfer.toStoreId]),
    );

    return {
      transfers: transfers.map(transfer => {
        const {bagId, ...publicTransfer} = transfer;
        return {
          ...publicTransfer,
          fromStore: storeLocation(transfer.fromStoreId),
          toStore: storeLocation(transfer.toStoreId),
          bagNumbers: [...new Set([bagId, ...(bagIdsByTransfer.get(transfer.id) ?? [])])]
            .map(id => bagNumbers.get(id))
            .filter((number): number is number => number !== undefined),
        };
      }),
    };
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
    const transfer = await this.findTransfer(id);
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
    const storeLocation = await this.storeLocations([transfer.fromStoreId, transfer.toStoreId]);

    return {
      transfer: {
        ...transfer,
        fromStore: storeLocation(transfer.fromStoreId),
        toStore: storeLocation(transfer.toStoreId),
      },
      items,
      bags: bags.map(b => ({id: b.id, bagNumber: b.bagNumber})),
    };
  }

  // ─── Status: in transit / delivered ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['rider']})
  @patch('/rider/transfers/{id}/status')
  @response(200, {
    description:
      'in_transit: transfer marked in transit. delivered: handover recorded with the item-count ' +
      'comparison (422 with the comparison when a mismatch has no discrepancyReason).',
  })
  async updateTransferStatus(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: {
              status: {type: 'string', enum: [TransferStatus.IN_TRANSIT, TransferStatus.DELIVERED]},
              bagIds: {
                type: 'array',
                nullable: true,
                items: {type: 'string', format: 'uuid'},
                description:
                  'status=in_transit (required): every bag belonging to this transfer, scanned by the ' +
                  'rider before pickup — must exactly cover the transfer\'s full bag set or the status ' +
                  'change is rejected.',
              },
              itemCount: {
                type: 'integer',
                nullable: true,
                minimum: 0,
                description: 'status=in_transit (optional): physical item count verified by the rider before transit.',
              },
              deliveredItemCount: {
                description:
                  'status=delivered (required): total number of individual items handed over for ' +
                  'this transfer — a non-negative integer.',
              },
              discrepancyReason: {
                type: 'string',
                nullable: true,
                description:
                  'status=delivered: required when deliveredItemCount differs from the dispatched count.',
              },
            },
          },
        },
      },
    })
    body: StatusUpdateBody,
  ): Promise<object> {
    if (body?.status === TransferStatus.DELIVERED) {
      return this.markDelivered(currentUser, id, body);
    }
    return this.startTransit(currentUser, id, body);
  }

  async startTransit(currentUser: UserProfile, id: string, body: StatusUpdateBody): Promise<object> {
    if (body.status !== TransferStatus.IN_TRANSIT) {
      throw new HttpErrors.BadRequest(
        `Riders can only set status to ${TransferStatus.IN_TRANSIT} or ${TransferStatus.DELIVERED}.`,
      );
    }
    if (!Array.isArray(body.bagIds)) {
      // Same status/code the request-body schema produced while bagIds was
      // schema-required for every call.
      throw Object.assign(
        new HttpErrors.UnprocessableEntity('bagIds is required when status is in_transit.'),
        {code: 'VALIDATION_FAILED'},
      );
    }
    const rider = await this.resolveActiveRider(currentUser);
    const transfer = await this.findTransfer(id);
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This transfer is not assigned to you.');
    }
    if (transfer.status !== TransferStatus.RIDER_ASSIGNED) {
      throw new HttpErrors.BadRequest(`Cannot start transit on a transfer that is ${transfer.status}, not rider_assigned.`);
    }

    // Every bag in the transfer must be scanned before the rider can start
    // transit — items written before multi-bag transfers existed have no
    // bagId of their own and fall back to the transfer's own primary bagId.
    const items = await this.transferItemRepository.find({where: {transferId: transfer.id} as object});
    const expectedItemCount = Number(transfer.itemCount ?? items.length);
    // null is "not sent", like an absent field.
    const verifiedItemCount = body.itemCount ?? undefined;
    if (
      verifiedItemCount !== undefined &&
      (!Number.isInteger(verifiedItemCount) || verifiedItemCount < 0 || verifiedItemCount > expectedItemCount)
    ) {
      throw new HttpErrors.BadRequest(
        `Verified itemCount must be between 0 and the expected count of ${expectedItemCount}.`,
      );
    }
    const expectedBagIds = new Set(items.map(i => i.bagId ?? transfer.bagId).filter(Boolean));
    if (transfer.bagId) expectedBagIds.add(transfer.bagId);
    const scannedBagIds = new Set(body.bagIds);
    const missing = [...expectedBagIds].filter(bagId => !scannedBagIds.has(bagId));
    if (missing.length) {
      const bags = await this.bagRepository.find({where: {id: {inq: missing}} as object});
      const labels = bags.map(b => b.bagNumber).join(', ') || `${missing.length} bag(s)`;
      throw new HttpErrors.BadRequest(`Scan every bag in this transfer before starting transit — still missing: ${labels}.`);
    }

    const {v4} = await import('uuid');
    const transaction = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    try {
      const {count} = await this.transferRepository.updateAll(
        {
          status: TransferStatus.IN_TRANSIT,
          ...(verifiedItemCount === undefined ? {} : {riderVerifiedItemCount: verifiedItemCount}),
          inTransitAt: new Date(),
          inTransitBy: currentUser[securityId],
        },
        {id: transfer.id, riderId: rider.id, status: TransferStatus.RIDER_ASSIGNED, isDeleted: false} as object,
        {transaction},
      );
      if (count !== 1) {
        throw new HttpErrors.Conflict('This transfer has already started transit.');
      }
      for (const bagId of expectedBagIds) {
        await this.custodyEventRepository.create({
          id: v4(),
          transferId: transfer.id,
          eventType: TransferCustodyEventType.BAG_SCANNED,
          bagId,
          performedBy: currentUser[securityId],
        }, {transaction});
      }
      await this.custodyEventRepository.create({
        id: v4(),
        transferId: transfer.id,
        eventType: TransferCustodyEventType.IN_TRANSIT,
        remarks: verifiedItemCount === undefined
          ? `Rider started transit without submitting an item count; manifest has ${expectedItemCount} item(s).`
          : `Rider verified ${verifiedItemCount} of ${expectedItemCount} item(s).`,
        performedBy: currentUser[securityId],
      }, {transaction});
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    return {
      message: 'Transfer marked in transit.',
      expectedItemCount,
      riderVerifiedItemCount: verifiedItemCount ?? null,
      shortageCount: verifiedItemCount === undefined ? null : expectedItemCount - verifiedItemCount,
    };
  }

  // ─── Delivered, with the rider's handover count ───────────────────────────

  /** The response for a recorded delivery — built only from stored fields, so a retry gets the same body. */
  private deliveryResult(transfer: Transfer) {
    const comparison = compareItemCounts(
      Number(transfer.dispatchedItemCount),
      Number(transfer.deliveredItemCount),
    );
    return {
      message:
        comparison.countVerificationStatus === 'matched'
          ? 'Transfer delivered. Item count matched.'
          : 'Transfer delivered with an item count mismatch — flagged for store review.',
      transferId: transfer.id,
      transitId: transfer.transitId,
      status: TransferStatus.DELIVERED,
      deliveredAt: transfer.deliveredAt,
      ...comparison,
      discrepancyReason: transfer.deliveryDiscrepancyReason ?? null,
      storeReviewRequired: Boolean(transfer.deliveryCountReviewRequired),
    };
  }

  private isSameDelivery(transfer: Transfer, riderId: string, deliveredItemCount: number, reason: string | null) {
    return (
      transfer.deliveredByRiderId === riderId &&
      Number(transfer.deliveredItemCount) === deliveredItemCount &&
      // A matched count stores no reason, so only a mismatch compares it.
      (transfer.deliveryCountStatus === 'matched' || (transfer.deliveryDiscrepancyReason ?? null) === reason)
    );
  }

  /** An already-recorded delivery: identical retry → same result; anything else → 409. */
  private replayDelivery(transfer: Transfer, riderId: string, deliveredItemCount: number, reason: string | null) {
    if (this.isSameDelivery(transfer, riderId, deliveredItemCount, reason)) {
      return this.deliveryResult(transfer);
    }
    const recorded = this.deliveryResult(transfer);
    throw Object.assign(
      new HttpErrors.Conflict(
        'This transfer has already been delivered with a different item count or reason; it cannot be changed.',
      ),
      {
        code: 'TRANSFER_ALREADY_DELIVERED',
        details: {
          expectedItemCount: recorded.expectedItemCount,
          deliveredItemCount: recorded.deliveredItemCount,
          difference: recorded.difference,
          countVerificationStatus: recorded.countVerificationStatus,
          discrepancyReason: recorded.discrepancyReason,
          deliveredAt: recorded.deliveredAt,
        },
      },
    );
  }

  /**
   * The dispatched item count (manifest rows; EXTRA rows only appear at
   * receive), computed on the first delivery attempt and persisted only if
   * still unset, so every retry compares against the same number. Null when
   * the manifest has no items to count.
   */
  private async ensureDispatchBaseline(transfer: Transfer): Promise<number | null> {
    if (transfer.dispatchedItemCount != null) return Number(transfer.dispatchedItemCount);
    const {count} = await this.transferItemRepository.count({
      transferId: transfer.id,
      scanStatus: {neq: TransferItemScanStatus.EXTRA},
    } as object);
    if (!count) return null;
    await this.transferRepository.updateAll(
      {dispatchedItemCount: count},
      {id: transfer.id, dispatchedItemCount: null} as object,
    );
    const fresh = await this.transferRepository.findById(transfer.id);
    return fresh.dispatchedItemCount == null ? null : Number(fresh.dispatchedItemCount);
  }

  async markDelivered(currentUser: UserProfile, id: string, body: StatusUpdateBody): Promise<object> {
    const deliveredItemCount = body.deliveredItemCount;
    if (
      typeof deliveredItemCount !== 'number' ||
      !Number.isInteger(deliveredItemCount) ||
      deliveredItemCount < 0 ||
      deliveredItemCount > MAX_ITEM_COUNT
    ) {
      throw Object.assign(
        new HttpErrors.BadRequest('deliveredItemCount is required and must be a non-negative integer.'),
        {code: 'INVALID_DELIVERED_ITEM_COUNT'},
      );
    }
    if (body.discrepancyReason != null && typeof body.discrepancyReason !== 'string') {
      throw new HttpErrors.BadRequest('discrepancyReason must be a string.');
    }
    // A blank reason counts as no reason.
    const trimmedReason = (body.discrepancyReason as string | undefined)?.trim();
    const reason = trimmedReason ? trimmedReason : null;

    const rider = await this.resolveActiveRider(currentUser);
    const transfer = await this.findTransfer(id);
    if (!transfer) throw new HttpErrors.NotFound('Transfer not found.');
    if (transfer.riderId !== rider.id) {
      throw new HttpErrors.Forbidden('This transfer is not assigned to you.');
    }

    // Already delivered (whatever the store has done since): replay or reject.
    if (transfer.deliveredAt) {
      return this.replayDelivery(transfer, rider.id, deliveredItemCount, reason);
    }
    if (transfer.status !== TransferStatus.IN_TRANSIT) {
      const finished = [TransferStatus.RECEIVED, TransferStatus.DISCREPANCY, TransferStatus.RESOLVED];
      if (finished.includes(transfer.status as TransferStatus)) {
        throw Object.assign(
          new HttpErrors.Conflict(`The destination store has already received this transfer (${transfer.status}).`),
          {code: 'TRANSFER_ALREADY_RECEIVED'},
        );
      }
      throw new HttpErrors.BadRequest(
        `Cannot mark a transfer delivered while it is ${transfer.status}; it must be in_transit.`,
      );
    }

    const expectedItemCount = await this.ensureDispatchBaseline(transfer);
    if (expectedItemCount == null) {
      throw Object.assign(
        new HttpErrors.Conflict(
          'The dispatched item count for this transfer is unavailable, so the delivery count cannot be ' +
            'verified. The status was not changed — ask the store to check the transfer manifest.',
        ),
        {code: 'DISPATCH_BASELINE_UNAVAILABLE'},
      );
    }

    const comparison = compareItemCounts(expectedItemCount, deliveredItemCount);
    const isMatch = comparison.countVerificationStatus === 'matched';
    if (!isMatch && !reason) {
      throw Object.assign(
        new HttpErrors.UnprocessableEntity(
          `Item count is ${comparison.countVerificationStatus}: ${deliveredItemCount} handed over, ` +
            `${expectedItemCount} dispatched. Provide discrepancyReason to complete the delivery.`,
        ),
        {code: 'DISCREPANCY_REASON_REQUIRED', details: comparison},
      );
    }

    // Status, rider, timestamp, counts and reason in one guarded write, in
    // one transaction; the guard makes a concurrent duplicate a no-op.
    const transaction = await this.dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    let recorded = false;
    try {
      const {count} = await this.transferRepository.updateAll(
        {
          status: TransferStatus.DELIVERED,
          deliveredAt: new Date(),
          deliveredByRiderId: rider.id,
          dispatchedItemCount: expectedItemCount,
          deliveredItemCount,
          deliveryCountStatus: comparison.countVerificationStatus,
          deliveryDiscrepancyReason: isMatch ? (null as unknown as string) : reason!,
          deliveryCountReviewRequired: !isMatch,
        },
        {
          id: transfer.id,
          riderId: rider.id,
          status: TransferStatus.IN_TRANSIT,
          deliveredAt: null,
          dispatchedItemCount: expectedItemCount,
          isDeleted: false,
        } as object,
        {transaction},
      );
      recorded = count === 1;
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    const latest = await this.transferRepository.findById(transfer.id);
    if (recorded) return this.deliveryResult(latest);
    // Lost a race — a concurrent request (often the same retry) or the
    // store's receive changed the transfer first.
    if (latest.deliveredAt) return this.replayDelivery(latest, rider.id, deliveredItemCount, reason);
    throw Object.assign(
      new HttpErrors.Conflict(`This transfer can no longer be marked delivered (${latest.status}).`),
      {code: 'TRANSFER_STATUS_CHANGED'},
    );
  }
}
