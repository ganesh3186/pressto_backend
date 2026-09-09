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
import {PickupRequest} from '../models/pickup-request.model';
import {
  ApprovalAuditLogRepository,
  ApprovalRequestRepository,
  BagRepository,
  GarmentRepository,
  ItemRepository,
  MediaRepository,
  OrderItemRepository,
  OrderRepository,
  PickupHandoverItemRepository,
  PickupHandoverRepository,
  PickupRequestRepository,
  ServiceRepository,
} from '../repositories';
import {OrderService} from '../services/order.service';

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
    @repository(ApprovalRequestRepository) private approvalRequestRepo: ApprovalRequestRepository,
    @repository(ApprovalAuditLogRepository) private approvalAuditLogRepo: ApprovalAuditLogRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(ItemRepository) private itemRepo: ItemRepository,
    @repository(ServiceRepository) private serviceRepo: ServiceRepository,
    @inject('services.order') private orderService: OrderService,
  ) {}

  /**
   * For pickups flagged isReworkPickup, batch-resolve "what this rework is
   * actually for" — the original order number, the reason the customer gave
   * when the reprocess request was raised, and each affected garment's
   * item/service names — so the receiving screen can show it next to what's
   * physically coming back, for a quick eyeball check before confirming.
   */
  private async _buildReworkContexts(
    pickups: PickupRequest[],
  ): Promise<Map<string, {
    orderNumber: string | null;
    reason: string | null;
    requestReason: string | null;
    garments: Array<{id: string; garmentTagNumber: string | null; itemName: string | null; serviceName: string | null}>;
  }>> {
    const reworkPickups = pickups.filter(p => p.isReworkPickup && p.reworkApprovalRequestId);
    const result = new Map<string, {
      orderNumber: string | null;
      reason: string | null;
      requestReason: string | null;
      garments: Array<{id: string; garmentTagNumber: string | null; itemName: string | null; serviceName: string | null}>;
    }>();
    if (!reworkPickups.length) return result;

    const approvalIds = [...new Set(reworkPickups.map(p => p.reworkApprovalRequestId!))];
    const approvals = await this.approvalRequestRepo.find({where: {id: {inq: approvalIds}} as object});
    const approvalById = new Map(approvals.map(a => [a.id, a]));

    const orderIds = [...new Set(reworkPickups.map(p => p.reworkOfOrderId).filter((id): id is string => Boolean(id)))];
    const orders = orderIds.length ? await this.orderRepo.find({where: {id: {inq: orderIds}} as object}) : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    const allGarmentIds = new Set<string>();
    for (const approval of approvals) {
      const meta = (approval.metadata ?? {}) as Record<string, unknown>;
      if (Array.isArray(meta.garmentIds)) (meta.garmentIds as string[]).forEach(id => allGarmentIds.add(id));
    }
    const garments = allGarmentIds.size
      ? await this.garmentRepo.find({where: {id: {inq: [...allGarmentIds]}} as object})
      : [];
    const garmentById = new Map(garments.map(g => [g.id, g]));

    const orderItemIds = [...new Set(garments.map(g => g.orderItemId).filter(Boolean))];
    const orderItems = orderItemIds.length
      ? await this.orderItemRepo.find({where: {id: {inq: orderItemIds}} as object})
      : [];
    const orderItemById = new Map(orderItems.map(oi => [oi.id, oi]));

    const itemIds = [...new Set(orderItems.map(oi => oi.itemId).filter(Boolean))];
    const serviceIds = [...new Set(orderItems.map(oi => oi.serviceId).filter(Boolean))];
    const [items, services] = await Promise.all([
      itemIds.length ? this.itemRepo.find({where: {id: {inq: itemIds}} as object}) : Promise.resolve([]),
      serviceIds.length ? this.serviceRepo.find({where: {id: {inq: serviceIds}} as object}) : Promise.resolve([]),
    ]);
    const itemNameById = new Map(items.map(i => [i.id, i.name]));
    const serviceNameById = new Map(services.map(s => [s.id, s.name]));

    for (const pickup of reworkPickups) {
      const approval = approvalById.get(pickup.reworkApprovalRequestId!);
      if (!approval) continue;
      const meta = (approval.metadata ?? {}) as Record<string, unknown>;
      const garmentIds = Array.isArray(meta.garmentIds) ? (meta.garmentIds as string[]) : [];
      result.set(pickup.id, {
        orderNumber: orderById.get(pickup.reworkOfOrderId ?? '')?.orderNumber ?? null,
        reason: typeof meta.reason === 'string' ? meta.reason : null,
        requestReason: approval.requestReason ?? null,
        garments: garmentIds.map(id => {
          const garment = garmentById.get(id);
          const orderItem = garment ? orderItemById.get(garment.orderItemId) : undefined;
          return {
            id,
            garmentTagNumber: garment?.garmentTagNumber ?? null,
            itemName: orderItem ? itemNameById.get(orderItem.itemId) ?? null : null,
            serviceName: orderItem ? serviceNameById.get(orderItem.serviceId) ?? null : null,
          };
        }),
      });
    }
    return result;
  }

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

    const reworkContextByPickupId = await this._buildReworkContexts(pickups);

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
        // Present only for a pickup flagged isReworkPickup — the original
        // item(s)/reason this rework is for, so the receiving screen can
        // show it next to what's physically coming back.
        isReworkPickup: pickup?.isReworkPickup ?? false,
        reworkContext: pickup?.isReworkPickup ? reworkContextByPickupId.get(pickup.id) ?? null : null,
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

  /**
   * A rework pickup's garment has just arrived — create the ₹0 rework order
   * now, same as the in-store flow's immediate path
   * (ApprovalService._applyPostDeliveryReprocess), just triggered from here
   * instead of from approval time. Links the pickup and the original
   * approval back to the new order atomically with the rest of the confirm
   * action, rather than the racy two-step PATCH a normal order relies on.
   * Returns null (and leaves everything else in the batch to proceed
   * normally) if anything about the link looks stale — e.g. a second
   * handover somehow already fulfilled it — rather than failing the whole
   * batch over one bad pickup.
   */
  private async _createReworkOrderForPickup(
    pickupRequest: PickupRequest,
    performedBy: string,
  ): Promise<{orderId: string; orderNumber: string} | null> {
    if (!pickupRequest.reworkOfOrderId || !pickupRequest.reworkApprovalRequestId) return null;

    const approval = await this.approvalRequestRepo.findOne({
      where: {id: pickupRequest.reworkApprovalRequestId} as object,
    });
    if (!approval) return null;
    const meta = (approval.metadata ?? {}) as Record<string, unknown>;
    if (meta.reworkOrderId) return null; // already fulfilled — don't double-create
    const garmentIds = Array.isArray(meta.garmentIds) ? (meta.garmentIds as string[]) : [];
    if (!garmentIds.length) return null;

    const result = await this.orderService.createReworkOrder({
      originalOrderId: pickupRequest.reworkOfOrderId,
      garmentIds,
      createdBy: performedBy,
      reason: typeof meta.reason === 'string' ? meta.reason : undefined,
      remarks: approval.requestReason,
    });

    await this.orderRepo.updateById(result.order.id, {pickupSource: pickupRequest.source});

    await this.approvalRequestRepo.updateById(approval.id, {
      metadata: {...meta, reworkOrderId: result.order.id, reworkOrderNumber: result.order.orderNumber},
    });

    const {v4} = await import('uuid');
    await this.approvalAuditLogRepo.create({
      id: v4(),
      approvalRequestId: approval.id,
      eventType: 'reprocess_order_created',
      remarks:
        `Free rework order ${result.order.orderNumber} created with ` +
        `${result.garmentsCreated} garment(s) after pickup ${pickupRequest.pickupNumber ?? pickupRequest.id} was received.`,
      performedBy,
    });

    return {orderId: result.order.id, orderNumber: result.order.orderNumber};
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
    const reworkOrdersCreated: Array<{orderId: string; orderNumber: string}> = [];
    for (const item of items) {
      const pickupRequest = await this.pickupRequestRepo.findOne({where: {id: item.pickupRequestId}});
      if (!pickupRequest) continue;

      let reworkOrder: {orderId: string; orderNumber: string} | null = null;
      if (pickupRequest.isReworkPickup) {
        reworkOrder = await this._createReworkOrderForPickup(pickupRequest, currentUser[securityId]);
        if (reworkOrder) reworkOrdersCreated.push(reworkOrder);
      }

      await this.pickupRequestRepo.updateById(pickupRequest.id, {
        status: PickupRequestStatus.RECEIVED_AT_STORE,
        ...(reworkOrder ? {convertedOrderId: reworkOrder.orderId} : {}),
      });

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

    return {message: 'Pickup handover confirmed received.', reworkOrdersCreated};
  }
}
