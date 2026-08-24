import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {BagStatus} from '../models/bag-status.enum';
import {PickupHandoverStatus} from '../models/pickup-handover-status.enum';
import {PickupHandoverTargetType} from '../models/pickup-handover-target-type.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {
  BagRepository,
  PickupHandoverItemRepository,
  PickupHandoverRepository,
  PickupRequestRepository,
} from '../repositories';

/**
 * Admin-facing surface for the store side of "Handover orders" — the
 * admin panel's "Receive Items" screen, which scans the QR/code a rider
 * shows on their app (RiderPickupHandoverController.submitHandover) and
 * receives the whole batch in one action. Store-targeted batches only —
 * a rider-targeted one (Rider/Van) is confirmed by the receiving rider
 * themselves, via POST /rider/pickup-handovers/confirm.
 */
export class PickupHandoverController {
  constructor(
    @repository(PickupHandoverRepository) private handoverRepo: PickupHandoverRepository,
    @repository(PickupHandoverItemRepository) private handoverItemRepo: PickupHandoverItemRepository,
    @repository(PickupRequestRepository) private pickupRequestRepo: PickupRequestRepository,
    @repository(BagRepository) private bagRepo: BagRepository,
  ) {}

  // Batch-attaches each item's PickupRequest detail — bag number, real
  // confirmed per-service counts, and any special instructions — so the
  // admin receive screen doesn't have to make a separate call per pickup.
  private async enrichItems<T extends {pickupRequestId: string}>(items: T[]) {
    const pickupIds = [...new Set(items.map(i => i.pickupRequestId))];
    const pickups = pickupIds.length
      ? await this.pickupRequestRepo.find({where: {id: {inq: pickupIds}} as object})
      : [];
    const pickupById = new Map(pickups.map(p => [p.id, p]));

    const bagIds = [...new Set(pickups.map(p => p.bagId).filter((id): id is string => Boolean(id)))];
    const bags = bagIds.length ? await this.bagRepo.find({where: {id: {inq: bagIds}} as object}) : [];
    const bagNumberById = new Map(bags.map(b => [b.id, b.bagNumber]));

    return items.map(item => {
      const pickup = pickupById.get(item.pickupRequestId);
      return {
        ...item,
        bagId: pickup?.bagId ?? null,
        bagNumber: pickup?.bagId ? bagNumberById.get(pickup.bagId) ?? null : null,
        itemCountEstimate: pickup?.itemCountEstimate ?? null,
        itemCategoryEstimate: pickup?.itemCategoryEstimate ?? null,
        actualItemsByService: pickup?.actualItemsByService ?? null,
        remarks: pickup?.remarks ?? null,
        mediaIds: pickup?.mediaIds ?? null,
      };
    });
  }

  // ─── Store-targeted batches (pending list / receive history) ────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-handovers')
  @response(200, {description: 'Store-targeted pickup handover batches'})
  async find(@param.query.string('status') status?: PickupHandoverStatus): Promise<object> {
    const handovers = await this.handoverRepo.find({
      where: {
        handoverToType: PickupHandoverTargetType.STORE,
        isDeleted: false,
        status: status ?? PickupHandoverStatus.PENDING,
      } as object,
      order: ['submittedAt DESC'],
    });
    const handoverIds = handovers.map(h => h.id);
    const rawItems = handoverIds.length
      ? await this.handoverItemRepo.find({where: {pickupHandoverId: {inq: handoverIds}} as object})
      : [];
    const items = await this.enrichItems(rawItems);
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByHandover.get(item.pickupHandoverId) ?? [];
      list.push(item);
      itemsByHandover.set(item.pickupHandoverId, list);
    }

    return {handovers: handovers.map(h => ({...h, items: itemsByHandover.get(h.id) ?? []}))};
  }

  // ─── Resolve a scanned code before receiving ─────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/pickup-handovers/lookup')
  @response(200, {description: 'Pickup handover batch resolved by its scanned/entered code'})
  async lookup(@param.query.string('code') code: string): Promise<object> {
    if (!code?.trim()) throw new HttpErrors.BadRequest('Query param "code" is required.');

    const handover = await this.handoverRepo.findOne({where: {handoverCode: code.trim(), isDeleted: false}});
    if (!handover) throw new HttpErrors.NotFound('No handover found for this code.');
    if (handover.handoverToType === PickupHandoverTargetType.RIDER) {
      throw new HttpErrors.BadRequest(
        'This handover is directed to a rider, not a store — it must be confirmed by that rider, not here.',
      );
    }

    const rawItems = await this.handoverItemRepo.find({where: {pickupHandoverId: handover.id} as object});
    const items = await this.enrichItems(rawItems);
    return {handover, items};
  }

  // ─── Receive the batch ────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:update']})
  @post('/pickup-handovers/{id}/confirm')
  @response(200, {description: 'Pickup handover confirmed received'})
  async confirm(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const handover = await this.handoverRepo.findOne({where: {id, isDeleted: false}});
    if (!handover) throw new HttpErrors.NotFound('Handover not found.');
    if (handover.status !== PickupHandoverStatus.PENDING) {
      throw new HttpErrors.BadRequest(`This handover is already ${handover.status}.`);
    }
    if (handover.handoverToType === PickupHandoverTargetType.RIDER) {
      throw new HttpErrors.BadRequest(
        'This handover is directed to a rider, not a store — it must be confirmed by that rider, not here.',
      );
    }

    const items = await this.handoverItemRepo.find({where: {pickupHandoverId: id} as object});
    for (const item of items) {
      const pickupRequest = await this.pickupRequestRepo.findOne({where: {id: item.pickupRequestId}});
      if (!pickupRequest) continue;
      await this.pickupRequestRepo.updateById(pickupRequest.id, {status: PickupRequestStatus.RECEIVED_AT_STORE});
      if (pickupRequest.bagId) {
        await this.bagRepo.updateById(pickupRequest.bagId, {
          status: BagStatus.AVAILABLE,
          itemCount: 0,
          currentPickupRequestId: null as unknown as string,
        });
      }
    }

    await this.handoverRepo.updateById(id, {
      status: PickupHandoverStatus.CONFIRMED,
      confirmedAt: new Date(),
      confirmedBy: currentUser[securityId],
    });

    return {message: 'Pickup handover confirmed received.'};
  }
}
