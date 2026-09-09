import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {OrderStatus} from '../models/order-status.enum';
import {ReprocessReason, reprocessWindowDays} from '../models/reprocess-reason.enum';
import {
  ApprovalRequestRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
} from '../repositories';
import {ApprovalService} from './approval.service';

/** Who started the request — the same flow serves both. */
export type ReprocessSource = 'customer' | 'store';

/**
 * How the customer got in touch, and — critically — whether the garment is
 * physically at the store yet. 'in_store' is the only value where it is:
 * approving the request immediately creates the ₹0 rework order, exactly as
 * before this field existed. Every other value means the piece is still at
 * the customer's home — approving just records the decision, and the rework
 * order only gets created later, once a linked pickup actually brings the
 * garment back (see ApprovalService._applyPostDeliveryReprocess and the
 * pickup-handover confirm flow).
 *
 * Named "contactChannel," not "requestSource" — that name is already taken
 * by the `source` field above (who raised it: customer vs store), and
 * `approval.controller.ts`'s enrichRequest() already exposes `source` as
 * `requestSource` in the API response. Also deliberately not called
 * anything with "reprocess" in it — the pickup domain already uses that
 * word for an unrelated concept (retrying a failed pickup attempt).
 */
export type ReprocessContactChannel = 'in_store' | 'phone' | 'whatsapp' | 'other';

export interface RaiseReprocessInput {
  orderId: string;
  /**
   * Pieces to redo. Omit to mean "the whole order" — it is expanded to every
   * delivered garment, because the workshop always works piece by piece.
   */
  garmentIds?: string[];
  reason: ReprocessReason;
  remarks?: string;
  mediaIds?: string[];
  requestedBy: string;
  source: ReprocessSource;
  /** Defaults to 'in_store' — see ReprocessContactChannel above. */
  contactChannel?: ReprocessContactChannel;
}

/**
 * Raising a "my item was not done properly" request against a delivered order.
 *
 * Kept apart from OrderService because it needs ApprovalService, and
 * ApprovalService already depends on OrderService — putting it in either would
 * make that a cycle.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class ReprocessService {
  constructor(
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(OrderStatusHistoryRepository)
    private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @repository(ApprovalRequestRepository)
    private approvalRequestRepo: ApprovalRequestRepository,
    @inject('services.approval') private approvalService: ApprovalService,
  ) {}

  async raiseRequest(input: RaiseReprocessInput): Promise<object> {
    const order = await this.orderRepo.findOne({
      where: {id: input.orderId, isDeleted: false},
    });
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    if (order.status !== OrderStatus.DELIVERED) {
      throw new HttpErrors.BadRequest(
        `Only a delivered order can be sent for reprocessing. This one is '${order.status}'.`,
      );
    }

    // "Other" is the escape hatch for anything the list does not cover, so it
    // has to say what actually went wrong.
    if (input.reason === ReprocessReason.OTHER && !input.remarks?.trim()) {
      throw new HttpErrors.BadRequest('Describe the problem in remarks when the reason is "Other".');
    }

    await this.assertWithinWindow(order.id, order.deliveryDate);

    const garmentIds = await this.resolveGarmentIds(order.id, input.garmentIds);

    // A second request for the same pieces while one is still pending would
    // create two rework orders for one complaint.
    await this.assertNoPendingRequest(order.id, garmentIds);

    const request = await this.approvalService.createRequest({
      type: ApprovalRequestType.REPROCESS,
      // Order-scoped, unlike the in-pipeline garment reprocess: the delivered
      // garments are terminal and the rework lands on a new order.
      entityType: 'order',
      entityId: order.id,
      requestedBy: input.requestedBy,
      requestReason: input.remarks,
      mediaIds: input.mediaIds,
      metadata: {
        reason: input.reason,
        garmentIds,
        source: input.source,
        contactChannel: input.contactChannel ?? 'in_store',
        originalOrderNumber: order.orderNumber,
      },
    });

    await this.statusHistoryRepo.create({
      id: (await import('uuid')).v4(),
      orderId: order.id,
      status: order.status,
      changedAt: new Date(),
      changedBy: input.requestedBy,
      remarks: `Reprocess requested (${input.reason}) for ${garmentIds.length} item(s) — awaiting approval`,
    });

    return {
      message: 'Reprocess request raised. Awaiting store exec approval.',
      request,
      garmentIds,
    };
  }

  /**
   * Claims are accepted for a limited period after delivery, so a complaint
   * cannot arrive months later. Env-driven via REPROCESS_WINDOW_DAYS.
   */
  private async assertWithinWindow(orderId: string, deliveryDate?: Date): Promise<void> {
    const windowDays = reprocessWindowDays();

    // The promised date can differ from when it actually went out — prefer the
    // recorded delivery event, fall back to the order's date.
    const history = await this.statusHistoryRepo.findOne({
      where: {orderId, status: OrderStatus.DELIVERED} as any,
      order: ['changedAt DESC'],
    });
    const deliveredAt = history?.changedAt ?? deliveryDate;
    if (!deliveredAt) return; // no delivery timestamp to judge against — allow it

    const ageDays = (Date.now() - new Date(deliveredAt).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > windowDays) {
      throw new HttpErrors.BadRequest(
        `Reprocess can only be requested within ${windowDays} days of delivery. ` +
          `This order was delivered ${Math.floor(ageDays)} days ago.`,
      );
    }
  }

  /**
   * A request may name specific pieces or the whole order. Either way it is
   * stored as an explicit garment list — the factory works piece by piece, and
   * "the whole order" would otherwise be ambiguous once items are added later.
   */
  private async resolveGarmentIds(orderId: string, requested?: string[]): Promise<string[]> {
    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const orderItemIds = orderItems.map(oi => oi.id);
    if (!orderItemIds.length) {
      throw new HttpErrors.BadRequest('This order has no items to reprocess.');
    }

    const garments = await this.garmentRepo.find({
      where: {orderItemId: {inq: orderItemIds}, isDeleted: false} as any,
    });
    if (!garments.length) {
      throw new HttpErrors.BadRequest('This order has no garments to reprocess.');
    }

    if (!requested?.length) {
      return garments.map(g => g.id); // whole order
    }

    const belongs = new Set(garments.map(g => g.id));
    const unknown = requested.filter(id => !belongs.has(id));
    if (unknown.length) {
      throw new HttpErrors.BadRequest(
        `These garments do not belong to this order: ${unknown.join(', ')}`,
      );
    }
    return requested;
  }

  /**
   * Blocks a duplicate while one is still pending. Repeat requests are allowed
   * once the previous one has been resolved — a piece can genuinely come back
   * twice.
   */
  private async assertNoPendingRequest(orderId: string, garmentIds: string[]): Promise<void> {
    const pending = await this.approvalRequestRepo.find({
      where: {
        type: ApprovalRequestType.REPROCESS,
        entityType: 'order',
        entityId: orderId,
        status: ApprovalRequestStatus.PENDING,
      } as any,
    });
    if (!pending.length) return;

    const requested = new Set(garmentIds);
    for (const request of pending) {
      const already = ((request.metadata ?? {}) as Record<string, unknown>).garmentIds;
      const overlap = Array.isArray(already)
        ? (already as string[]).filter(id => requested.has(id))
        : [];
      if (overlap.length) {
        throw new HttpErrors.Conflict(
          'A reprocess request for one or more of these items is already awaiting approval.',
        );
      }
    }
  }
}
