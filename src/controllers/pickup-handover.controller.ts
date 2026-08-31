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
  MediaRepository,
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
    @repository(MediaRepository) private mediaRepo: MediaRepository,
  ) {}

  // Batch-attaches each item's PickupRequest detail — bag(s), real
  // confirmed per-service counts, and any special instructions — so the
  // admin receive screen doesn't have to make a separate call per pickup.
  private async enrichItems<T extends {pickupRequestId: string}>(items: T[]) {
    const pickupIds = [...new Set(items.map(i => i.pickupRequestId))];
    const pickups = pickupIds.length
      ? await this.pickupRequestRepo.find({where: {id: {inq: pickupIds}} as object})
      : [];
    const pickupById = new Map(pickups.map(p => [p.id, p]));

    // A pickup now uses one bag per service — collect every bag referenced
    // anywhere (the legacy primary bagId, plus each actualItemsByService
    // line's own bagId) in one batch.
    const bagIds = new Set<string>();
    for (const pickup of pickups) {
      if (pickup.bagId) bagIds.add(pickup.bagId);
      (pickup.actualItemsByService ?? []).forEach(line => line.bagId && bagIds.add(line.bagId));
    }
    const bags = bagIds.size ? await this.bagRepo.find({where: {id: {inq: [...bagIds]}} as object}) : [];
    const bagNumberById = new Map(bags.map(b => [b.id, b.bagNumber]));

    // Batch-resolve every mediaId referenced anywhere (top-level special-
    // instruction photos + each actualItemsByService line's photos) to its
    // fileUrl in one query — same convention as
    // GarmentController._attachMediaUrls, since image records/JSON blobs
    // only ever store the bare mediaId.
    const allMediaIds = new Set<string>();
    for (const pickup of pickups) {
      (pickup.mediaIds ?? []).forEach(id => id && allMediaIds.add(id));
      (pickup.actualItemsByService ?? []).forEach(line => (line.mediaIds ?? []).forEach(id => id && allMediaIds.add(id)));
    }
    const mediaRecords = allMediaIds.size
      ? await this.mediaRepo.find({where: {id: {inq: [...allMediaIds]}} as object})
      : [];
    const mediaUrlById = new Map(mediaRecords.map(m => [m.id, m.fileUrl]));
    const toUrls = (ids?: string[]) => (ids ?? []).map(id => mediaUrlById.get(id)).filter((url): url is string => Boolean(url));

    return items.map(item => {
      const pickup = pickupById.get(item.pickupRequestId);
      return {
        ...item,
        // Legacy single-bag snapshot — still populated (first/primary bag)
        // for anything not yet reading the per-service breakdown below.
        bagId: pickup?.bagId ?? null,
        bagNumber: pickup?.bagId ? bagNumberById.get(pickup.bagId) ?? null : null,
        itemCountEstimate: pickup?.itemCountEstimate ?? null,
        itemCategoryEstimate: pickup?.itemCategoryEstimate ?? null,
        actualItemsByService: (pickup?.actualItemsByService ?? null)?.map(line => ({
          ...line,
          mediaUrls: toUrls(line.mediaIds),
          bagNumber: line.bagId ? bagNumberById.get(line.bagId) ?? null : null,
        })) ?? null,
        remarks: pickup?.remarks ?? null,
        mediaIds: pickup?.mediaIds ?? null,
        mediaUrls: toUrls(pickup?.mediaIds),
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

      // One bag per service now — release every bag this pickup actually
      // used (each actualItemsByService line's bagId), plus the legacy
      // top-level bagId for back-compat with rows written before per-service
      // bags existed. A Set collapses the (expected) overlap where bagId is
      // just the first service's bag, so nothing is released twice.
      const bagIdsToRelease = new Set<string>();
      if (pickupRequest.bagId) bagIdsToRelease.add(pickupRequest.bagId);
      (pickupRequest.actualItemsByService ?? []).forEach(line => line.bagId && bagIdsToRelease.add(line.bagId));

      for (const bagId of bagIdsToRelease) {
        await this.bagRepo.updateById(bagId, {
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
