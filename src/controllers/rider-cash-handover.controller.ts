import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RiderCashHandoverStatus} from '../models/rider-cash-handover-status.enum';
import {RiderCashHandoverTargetType} from '../models/rider-cash-handover-target-type.enum';
import {
  PaymentTransactionRepository,
  OrderRepository,
  RiderCashHandoverItemRepository,
  RiderCashHandoverRepository,
  RiderRepository,
  StoreRepository,
  UsersRepository,
} from '../repositories';

/**
 * Admin-facing surface for rider cash handovers — fills the "Cash Pending"
 * tab (cash-received-view.js) and its history drill-down
 * (cash-pending-history-view.js) in the admin panel, both of which already
 * exist and were waiting on this backend.
 */
export class RiderCashHandoverController {
  constructor(
    @repository(PaymentTransactionRepository) private paymentTransactionRepo: PaymentTransactionRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(RiderCashHandoverRepository) private handoverRepo: RiderCashHandoverRepository,
    @repository(RiderCashHandoverItemRepository) private handoverItemRepo: RiderCashHandoverItemRepository,
    @repository(RiderRepository) private riderRepo: RiderRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(UsersRepository) private usersRepo: UsersRepository,
  ) {}

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_cash_handover:read']})
  @get('/rider-cash-handovers')
  @response(200, {description: 'Store-targeted rider cash handover batches'})
  async find(@param.query.string('status') status?: RiderCashHandoverStatus): Promise<object> {
    const requestedStatus = status ?? RiderCashHandoverStatus.PENDING;
    if (!Object.values(RiderCashHandoverStatus).includes(requestedStatus)) {
      throw new HttpErrors.BadRequest('Status must be pending or confirmed.');
    }

    const handovers = await this.handoverRepo.find({
      where: {
        and: [
          {isDeleted: false},
          {status: requestedStatus},
          {
            or: [
              {handoverToType: RiderCashHandoverTargetType.STORE},
              // Rows created before target selection existed were store-bound.
              {handoverToType: {eq: null}},
            ],
          },
        ],
      } as object,
      order: [requestedStatus === RiderCashHandoverStatus.CONFIRMED ? 'confirmedAt DESC' : 'submittedAt DESC'],
    });
    const handoverIds = handovers.map(h => h.id);
    const items = handoverIds.length
      ? await this.handoverItemRepo.find({where: {riderCashHandoverId: {inq: handoverIds}} as object})
      : [];
    const itemsByHandover = new Map<string, typeof items>();
    for (const item of items) {
      const own = itemsByHandover.get(item.riderCashHandoverId) ?? [];
      own.push(item);
      itemsByHandover.set(item.riderCashHandoverId, own);
    }

    const confirmerIds = [...new Set(handovers.map(h => h.confirmedBy).filter((id): id is string => Boolean(id)))];
    const confirmers = confirmerIds.length
      ? await this.usersRepo.find({
          where: {id: {inq: confirmerIds}} as object,
          fields: {id: true, fullName: true} as object,
        })
      : [];
    const confirmerNameById = new Map(confirmers.map(user => [user.id, user.fullName]));

    return {
      handovers: handovers.map(handover => ({
        ...handover,
        confirmedByName: handover.confirmedBy
          ? confirmerNameById.get(handover.confirmedBy) ?? 'Admin user'
          : null,
        items: itemsByHandover.get(handover.id) ?? [],
      })),
    };
  }

  // ─── Per-rider pending summary ───────────────────────────────────────────
  // Scoped to riders with ANY cash still outside the store's hands
  // (with_rider or submitted) — a rider whose cash has all been confirmed
  // handed_over simply doesn't appear here at all, rather than lingering as
  // a stale "Completed ₹0" row.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_cash_handover:read']})
  @get('/rider-cash-handovers/pending-summary')
  @response(200, {description: 'Per-rider cash-pending summary'})
  async pendingSummary(): Promise<object> {
    const transactions = await this.paymentTransactionRepo.find({
      where: {riderId: {neq: null}, riderHandoverStatus: {inq: ['with_rider', 'submitted']}} as object,
    });
    if (!transactions.length) return {summary: []};

    const riderIds = [...new Set(transactions.map(t => (t as unknown as {riderId: string}).riderId))];
    const riders = await this.riderRepo.find({where: {id: {inq: riderIds}} as object});
    const orderIds = [...new Set(transactions.map(t => t.orderId))];
    const orders = await this.orderRepo.find({
      where: {id: {inq: orderIds}} as object,
      fields: {id: true, storeId: true} as object,
    });
    const orderStoreById = new Map(orders.map(order => [order.id, order.storeId]));
    const storeIds = [...new Set(orders.map(order => order.storeId).filter(Boolean))];
    const stores = storeIds.length
      ? await this.storeRepo.find({where: {id: {inq: storeIds}} as object, fields: {id: true, name: true} as object})
      : [];
    const storeNameById = new Map(stores.map(store => [store.id, store.name]));
    const userIds = riders.map(r => r.userId);
    const users = userIds.length
      ? await this.usersRepo.find({where: {id: {inq: userIds}} as object, fields: {id: true, phone: true} as object})
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    const summary = riders.flatMap(rider => {
      const riderTransactions = transactions.filter(t => (t as unknown as {riderId: string}).riderId === rider.id);
      const byStore = new Map<string, typeof transactions>();
      for (const transaction of riderTransactions) {
        const storeId = orderStoreById.get(transaction.orderId) ?? '';
        const own = byStore.get(storeId) ?? [];
        own.push(transaction);
        byStore.set(storeId, own);
      }
      return [...byStore.entries()].map(([storeId, own]) => {
      const pendingAmount = own.reduce((s, t) => s + Number(t.amount), 0);
      const hasSubmitted = own.some(t => (t as unknown as {riderHandoverStatus: string}).riderHandoverStatus === 'submitted');
      return {
        id: `${rider.id}:${storeId || 'unassigned'}`,
        riderId: rider.id,
        riderCode: rider.riderCode,
        firstName: rider.firstName,
        lastName: rider.lastName,
        mobile: userById.get(rider.userId)?.phone ?? '',
        pendingAmount,
        storeId,
        storeName: storeNameById.get(storeId) ?? 'Unassigned store',
        orderDate: own.reduce<Date | undefined>((latest, transaction) => {
          const value = transaction.paymentDate ?? transaction.createdAt;
          return !latest || (value && new Date(value) > new Date(latest)) ? value : latest;
        }, undefined),
        status: hasSubmitted ? 'Partially Received' : 'Pending',
      };
      });
    });

    return {summary};
  }

  // ─── Per-rider history drill-down ────────────────────────────────────────
  // Flattens both already-batched items (RiderCashHandoverItem) and any
  // not-yet-submitted with_rider transactions into one list — the same
  // "everything this rider is holding or has handed over" view either way.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_cash_handover:read']})
  @get('/rider-cash-handovers/pending-summary/{riderId}/history')
  @response(200, {description: 'Cash-collection history for one rider'})
  async pendingHistory(@param.path.string('riderId') riderId: string): Promise<object> {
    const rider = await this.riderRepo.findOne({where: {id: riderId, isDeleted: false}});
    if (!rider) throw new HttpErrors.NotFound('Rider not found.');

    const handovers = await this.handoverRepo.find({where: {riderId, isDeleted: false} as object});
    const handoverById = new Map(handovers.map(h => [h.id, h]));
    const handoverIds = handovers.map(h => h.id);
    const batchedItems = handoverIds.length
      ? await this.handoverItemRepo.find({where: {riderCashHandoverId: {inq: handoverIds}} as object})
      : [];
    const batchedTxIds = new Set(batchedItems.map(i => i.paymentTransactionId));

    const unbatched = await this.paymentTransactionRepo.find({
      where: {riderId, riderHandoverStatus: 'with_rider'} as object,
    });

    const rows = [
      ...batchedItems.map(item => ({
        id: item.id,
        handoverId: item.riderCashHandoverId,
        customer: {name: item.customerName, mobile: ''},
        orderCode: item.orderNumber,
        invoiceId: item.paymentTransactionId,
        amount: item.amount,
        status:
          handoverById.get(item.riderCashHandoverId)?.status === RiderCashHandoverStatus.CONFIRMED
            ? 'confirmed'
            : 'submitted',
      })),
      ...unbatched
        .filter(t => !batchedTxIds.has(t.id))
        .map(t => ({
          id: t.id,
          handoverId: null,
          customer: {name: '', mobile: ''},
          orderCode: '',
          invoiceId: t.id,
          amount: t.amount,
          status: 'with_rider',
        })),
    ];

    return {rider: {riderId: rider.id, riderCode: rider.riderCode, firstName: rider.firstName, lastName: rider.lastName}, history: rows};
  }

  // ─── Resolve a scanned/entered code before receiving ─────────────────────
  // Same scan-or-manual-entry-confirm convention as PickupHandoverController
  // .lookup — resolves the rider's "Handover Cash" QR/code so the admin
  // panel can preview the batch before confirming, instead of only being
  // able to tap "Confirm Receipt" on an already-browsed list row.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_cash_handover:read']})
  @get('/rider-cash-handovers/lookup')
  @response(200, {description: 'Cash handover batch resolved by its scanned/entered code'})
  async lookup(@param.query.string('code') code: string): Promise<object> {
    if (!code?.trim()) throw new HttpErrors.BadRequest('Query param "code" is required.');

    const handover = await this.handoverRepo.findOne({
      where: {handoverCode: code.trim(), isDeleted: false} as object,
    });
    if (!handover) throw new HttpErrors.NotFound('No handover found for this code.');
    if (handover.handoverToType === RiderCashHandoverTargetType.RIDER) {
      throw new HttpErrors.BadRequest(
        'This handover is directed to a rider, not a store — it must be confirmed by that rider, not here.',
      );
    }

    const items = await this.handoverItemRepo.find({where: {riderCashHandoverId: handover.id} as object});
    return {handover, items};
  }

  // ─── Confirm receipt of a handover batch ─────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['rider_cash_handover:update']})
  @post('/rider-cash-handovers/{id}/confirm')
  @response(200, {description: 'Handover confirmed received'})
  async confirm(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const handover = await this.handoverRepo.findOne({where: {id, isDeleted: false}});
    if (!handover) throw new HttpErrors.NotFound('Handover not found.');
    if (handover.status !== RiderCashHandoverStatus.PENDING) {
      throw new HttpErrors.BadRequest(`This handover is already ${handover.status}.`);
    }
    // A rider-targeted handover (Van/Rider in the app UI) is confirmed by
    // the receiving rider themselves — POST /rider/cash-handovers/{id}/confirm
    // — not here. Anything else (including a legacy row from before
    // handoverToType existed) is store-targeted and belongs on this path.
    if (handover.handoverToType === RiderCashHandoverTargetType.RIDER) {
      throw new HttpErrors.BadRequest(
        'This handover is directed to a rider, not a store — it must be confirmed by that rider, not here.',
      );
    }

    const items = await this.handoverItemRepo.find({where: {riderCashHandoverId: id} as object});
    for (const item of items) {
      await this.paymentTransactionRepo.updateById(
        item.paymentTransactionId,
        {riderHandoverStatus: 'handed_over'} as object,
      );
    }

    await this.handoverRepo.updateById(id, {
      status: RiderCashHandoverStatus.CONFIRMED,
      confirmedAt: new Date(),
      confirmedBy: currentUser[securityId],
    });

    return {message: 'Cash handover confirmed received.'};
  }
}
