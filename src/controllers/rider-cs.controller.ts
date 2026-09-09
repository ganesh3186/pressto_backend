import {authenticate} from '@loopback/authentication';
import {repository} from '@loopback/repository';
import {get, param, response} from '@loopback/rest';
import {authorize} from '../authorization';
import {PickupEscalationStatus} from '../models/pickup-escalation-status.enum';
import {OrderStatus} from '../models/order-status.enum';
import {
  CustomerRepository,
  OrderRepository,
  OrderStatusHistoryRepository,
  PickupEscalationRepository,
  PickupRequestRepository,
  RiderRepository,
  UsersRepository,
} from '../repositories';

type RiderCsCase = {
  id: string;
  caseType: 'escalation' | 'pickup_unsuccessful' | 'delivery_unsuccessful';
  customerName: string | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  riderName: string | null;
  reason: string;
  remark: string | null;
  status: 'open' | 'resolved';
  resolvable: boolean;
  resolutionRemark: string | null;
  createdAt: Date;
};

/**
 * Combined "Raised CS" queue for the admin panel's Rider Management screen
 * — unions three different rider-side issue signals into one read model:
 *   • PickupEscalation ("Raise to support") — the only genuinely
 *     resolvable case type, via PATCH /pickup-escalations/{id}/resolve.
 *   • PickupRequest.status = pickup_unsuccessful — read-only here; a
 *     pickup "resolves" itself by being reprocessed (rider-driven) or
 *     cancelled, not through this queue.
 *   • Order delivery-return events (OrderStatusHistory rows written by
 *     OrderService.returnDeliveryToStore) — likewise read-only; an order
 *     "resolves" by being redispatched.
 * "Open" vs "resolved" for the latter two is inferred from whether the
 * underlying record has moved on since, not a stored flag.
 */
export class RiderCsController {
  constructor(
    @repository(PickupEscalationRepository) private escalationRepo: PickupEscalationRepository,
    @repository(PickupRequestRepository) private pickupRequestRepo: PickupRequestRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderStatusHistoryRepository) private statusHistoryRepo: OrderStatusHistoryRepository,
    @repository(CustomerRepository) private customerRepo: CustomerRepository,
    @repository(RiderRepository) private riderRepo: RiderRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['pickup_request:read']})
  @get('/rider-cs-cases')
  @response(200, {description: 'Combined queue of rider-raised issues — escalations, unsuccessful pickups, and unsuccessful deliveries'})
  async find(@param.query.string('status') status?: 'open' | 'resolved'): Promise<object> {
    const [escalationCases, pickupCases, deliveryCases] = await Promise.all([
      this._escalationCases(),
      this._pickupUnsuccessfulCases(),
      this._deliveryUnsuccessfulCases(),
    ]);

    let cases = [...escalationCases, ...pickupCases, ...deliveryCases];
    if (status) cases = cases.filter(c => c.status === status);
    cases.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {cases};
  }

  private async _escalationCases(): Promise<RiderCsCase[]> {
    const escalations = await this.escalationRepo.find({where: {isDeleted: false} as object, order: ['raisedAt DESC']});
    if (!escalations.length) return [];

    const pickupIds = [...new Set(escalations.map(e => e.pickupRequestId))];
    const pickups = await this.pickupRequestRepo.find({where: {id: {inq: pickupIds}} as object});
    const pickupById = new Map(pickups.map(p => [p.id, p]));

    return escalations.map(e => ({
      id: `escalation:${e.id}`,
      caseType: 'escalation',
      customerName: pickupById.get(e.pickupRequestId)?.customerName ?? null,
      referenceNumber: e.pickupNumber ?? null,
      referenceDate: pickupById.get(e.pickupRequestId)?.requestedDate ?? null,
      riderName: e.riderName,
      reason: e.reason,
      remark: e.remark ?? null,
      status: e.status === PickupEscalationStatus.RESOLVED ? 'resolved' : 'open',
      resolvable: true,
      resolutionRemark: e.resolutionRemark ?? null,
      createdAt: e.raisedAt,
    }));
  }

  private async _pickupUnsuccessfulCases(): Promise<RiderCsCase[]> {
    const pickups = await this.pickupRequestRepo.find({
      where: {unsuccessfulAt: {neq: null}, isDeleted: false} as object,
      order: ['unsuccessfulAt DESC'],
    });
    return pickups.map(p => ({
      id: `pickup:${p.id}`,
      caseType: 'pickup_unsuccessful',
      customerName: p.customerName,
      referenceNumber: p.pickupNumber ?? null,
      referenceDate: p.requestedDate,
      riderName: p.assignedRiderName ?? null,
      reason: (p.unsuccessfulReasons ?? []).join(', ') || 'Unspecified',
      remark: p.unsuccessfulOtherReason ?? null,
      // Still sitting at pickup_unsuccessful = nobody has reprocessed/cancelled it yet.
      status: p.status === 'pickup_unsuccessful' ? 'open' : 'resolved',
      resolvable: false,
      resolutionRemark: null,
      createdAt: p.unsuccessfulAt as Date,
    }));
  }

  private async _deliveryUnsuccessfulCases(): Promise<RiderCsCase[]> {
    const events = await this.statusHistoryRepo.find({
      where: {status: OrderStatus.READY, remarks: {like: 'Delivery attempt failed%'}} as object,
      order: ['changedAt DESC'],
    });
    if (!events.length) return [];

    // Only the latest attempt per order is actionable — earlier ones on
    // the same order were already superseded by a redispatch.
    const latestByOrder = new Map<string, (typeof events)[number]>();
    for (const e of events) {
      if (!latestByOrder.has(e.orderId)) latestByOrder.set(e.orderId, e);
    }
    const latestEvents = [...latestByOrder.values()];

    const orderIds = latestEvents.map(e => e.orderId);
    const orders = await this.orderRepo.find({where: {id: {inq: orderIds}} as object});
    const orderById = new Map(orders.map(o => [o.id, o]));

    const customerIds = [...new Set(orders.map(o => o.customerId))];
    const customers = customerIds.length
      ? await this.customerRepo.find({where: {id: {inq: customerIds}} as object})
      : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    const changedByIds = [...new Set(latestEvents.map(e => e.changedBy).filter((id): id is string => Boolean(id)))];
    const riders = changedByIds.length ? await this.riderRepo.find({where: {userId: {inq: changedByIds}} as object}) : [];
    const riderByUserId = new Map(riders.map(r => [r.userId, r]));
    const users = changedByIds.length
      ? await this.usersRepo.find({where: {id: {inq: changedByIds}} as object, fields: {id: true, fullName: true} as object})
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    return latestEvents.map(e => {
      const order = orderById.get(e.orderId);
      const customer = order ? customerById.get(order.customerId) : undefined;
      const rider = e.changedBy ? riderByUserId.get(e.changedBy) : undefined;
      const riderName = rider ? `${rider.firstName} ${rider.lastName}` : (e.changedBy ? userById.get(e.changedBy)?.fullName : undefined);

      return {
        id: `delivery:${e.id}`,
        caseType: 'delivery_unsuccessful',
        customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
        referenceNumber: order?.orderNumber ?? null,
        referenceDate: e.changedAt?.toISOString() ?? null,
        riderName: riderName ?? null,
        reason: e.remarks ?? 'Unspecified',
        remark: null,
        // Still ready = nobody has redispatched it since this failed attempt.
        status: order?.status === OrderStatus.READY ? 'open' : 'resolved',
        resolvable: false,
        resolutionRemark: null,
        createdAt: e.changedAt as Date,
      };
    });
  }
}
