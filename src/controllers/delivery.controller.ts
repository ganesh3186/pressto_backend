import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {BagStatus} from '../models/bag-status.enum';
import {DeliveryCustodyEventType} from '../models/delivery-custody-event-type.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {Delivery} from '../models/delivery.model';
import {OrderDeliveryMethod} from '../models/order-delivery-method.enum';
import {OrderStatus} from '../models/order-status.enum';
import {
  BagRepository,
  DeliveryCustodyEventRepository,
  DeliveryOrderRepository,
  DeliveryRepository,
  OrderRepository,
  StoreRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

/**
 * Admin-facing surface for Delivery — created only when
 * POST /orders/delivery-assignment is called with a bagId (see
 * OrderController.assignDelivery). Mirrors transfer.controller.ts's
 * list/detail/stats/cancel shape.
 */
export class DeliveryController {
  constructor(
    @repository(DeliveryRepository) private deliveryRepo: DeliveryRepository,
    @repository(DeliveryOrderRepository) private deliveryOrderRepo: DeliveryOrderRepository,
    @repository(DeliveryCustodyEventRepository) private custodyEventRepo: DeliveryCustodyEventRepository,
    @repository(BagRepository) private bagRepo: BagRepository,
    @repository(StoreRepository) private storeRepo: StoreRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  private async enrichDeliveries(deliveries: Delivery[]): Promise<object[]> {
    if (!deliveries.length) return [];
    const storeIds = [...new Set(deliveries.map(d => d.storeId))];
    const bagIds = [...new Set(deliveries.map(d => d.bagId))];
    const [stores, bags] = await Promise.all([
      this.storeRepo.find({where: {id: {inq: storeIds}} as object}),
      this.bagRepo.find({where: {id: {inq: bagIds}} as object}),
    ]);
    const storeById = new Map(stores.map(s => [s.id, s]));
    const bagById = new Map(bags.map(b => [b.id, b]));

    return deliveries.map(d => ({
      ...d,
      storeName: storeById.get(d.storeId)?.name ?? null,
      storeCode: storeById.get(d.storeId)?.code ?? null,
      bagNumber: bagById.get(d.bagId)?.bagNumber ?? null,
    }));
  }

  // ─── List ───────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['delivery:read']})
  @get('/deliveries')
  @response(200, {description: 'Deliveries, filtered by status/rider/store/date'})
  async find(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.string('status') status?: DeliveryStatus,
    @param.query.string('riderId') riderId?: string,
    @param.query.string('storeId') storeId?: string,
    @param.query.string('dateFrom') dateFrom?: string,
    @param.query.string('dateTo') dateTo?: string,
  ): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {storeId});

    const and: object[] = [{isDeleted: false}];
    if (status) and.push({status});
    if (riderId) and.push({riderId});
    if (dateFrom ?? dateTo) {
      and.push({
        createdAt: {
          ...(dateFrom ? {gte: new Date(dateFrom)} : {}),
          ...(dateTo ? {lte: new Date(dateTo)} : {}),
        },
      });
    }
    if (narrowedStoreIds) and.push({storeId: {inq: narrowedStoreIds}});

    const deliveries = await this.deliveryRepo.find({where: {and} as object, order: ['createdAt DESC']});
    return {deliveries: await this.enrichDeliveries(deliveries)};
  }

  // ─── Summary Stats ──────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['delivery:read']})
  @get('/deliveries/stats')
  @response(200, {description: 'Summary counts by status'})
  async stats(@inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile): Promise<object> {
    const scope = await this.storeScopeService.resolve(currentUser);
    const narrowedStoreIds = await this.storeScopeService.narrowStoreIds(scope, {});

    const and: object[] = [{isDeleted: false}];
    if (narrowedStoreIds) and.push({storeId: {inq: narrowedStoreIds}});

    const deliveries = await this.deliveryRepo.find({
      where: {and} as object,
      fields: {status: true} as object,
    });

    return {
      stats: {
        total: deliveries.length,
        assigned: deliveries.filter(d => d.status === DeliveryStatus.ASSIGNED).length,
        outForDelivery: deliveries.filter(d => d.status === DeliveryStatus.OUT_FOR_DELIVERY).length,
        completed: deliveries.filter(d => d.status === DeliveryStatus.COMPLETED).length,
        cancelled: deliveries.filter(d => d.status === DeliveryStatus.CANCELLED).length,
      },
    };
  }

  // ─── Detail ─────────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['delivery:read']})
  @get('/deliveries/{id}')
  @response(200, {description: 'Delivery detail with orders and custody trail'})
  async findById(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const delivery = await this.deliveryRepo.findOne({where: {id, isDeleted: false}});
    if (!delivery) throw new HttpErrors.NotFound('Delivery not found.');

    const scope = await this.storeScopeService.resolve(currentUser);
    if (!this.storeScopeService.allows(scope, delivery.storeId)) {
      throw new HttpErrors.NotFound('Delivery not found.');
    }

    const [deliveryOrders, custodyEvents, [enriched]] = await Promise.all([
      this.deliveryOrderRepo.find({where: {deliveryId: id} as object}),
      this.custodyEventRepo.find({where: {deliveryId: id} as object, order: ['performedAt ASC']}),
      this.enrichDeliveries([delivery]),
    ]);

    const orderIds = deliveryOrders.map(o => o.orderId);
    const orders = orderIds.length
      ? await this.orderRepo.find({where: {id: {inq: orderIds}} as object})
      : [];
    const orderById = new Map(orders.map(o => [o.id, o]));

    return {
      delivery: enriched,
      orders: deliveryOrders.map(deliveryOrder => {
        const order = orderById.get(deliveryOrder.orderId);
        return {
          ...deliveryOrder,
          orderStatus: order?.status ?? null,
          deliveryAddress: order?.deliveryAddress ?? null,
        };
      }),
      custodyEvents,
    };
  }

  // ─── Cancel (admin, unstarted only) ──────────────────────────────────────
  // "Admin assigned the wrong rider" — no path today besides this. Only
  // while ASSIGNED (rider hasn't tapped "start" yet); reverts every linked
  // order still eligible back to a clean, unassigned state and frees the
  // bag. Once OUT_FOR_DELIVERY, use per-order delivery-return instead —
  // cancelling a run already on the road isn't this endpoint's job.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['delivery:update']})
  @post('/deliveries/{id}/cancel')
  @response(200, {description: 'Delivery cancelled, bag released'})
  async cancel(
    @param.path.string('id') id: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
  ): Promise<object> {
    const delivery = await this.deliveryRepo.findOne({where: {id, isDeleted: false}});
    if (!delivery) throw new HttpErrors.NotFound('Delivery not found.');
    if (delivery.status !== DeliveryStatus.ASSIGNED) {
      throw new HttpErrors.BadRequest(
        `Cannot cancel a delivery that is ${delivery.status}, not assigned.`,
      );
    }

    const {v4} = await import('uuid');
    const deliveryOrders = await this.deliveryOrderRepo.find({where: {deliveryId: id} as object});
    const orderIds = deliveryOrders.map(o => o.orderId);
    const orders = orderIds.length
      ? await this.orderRepo.find({where: {id: {inq: orderIds}} as object})
      : [];

    for (const order of orders) {
      if (order.status !== OrderStatus.READY && order.status !== OrderStatus.PARTIALLY_DISPATCHED) {
        continue; // already moved on (e.g. delivered some other way) — leave it alone
      }
      await this.orderRepo.updateById(order.id, {
        assignedRiderId: null as unknown as string,
        assignedRiderName: null as unknown as string,
        deliveryMethod: null as unknown as OrderDeliveryMethod,
        deliverySlot: null as unknown as string,
        deliverySlotId: null as unknown as string,
      });
    }

    await this.deliveryRepo.updateById(id, {
      status: DeliveryStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledBy: currentUser[securityId],
    });

    await this.bagRepo.updateById(delivery.bagId, {
      status: BagStatus.AVAILABLE,
      currentDeliveryId: null as unknown as string,
    });

    await this.custodyEventRepo.create({
      id: v4(),
      deliveryId: id,
      eventType: DeliveryCustodyEventType.CANCELLED,
      performedBy: currentUser[securityId],
    });

    return {message: 'Delivery cancelled. Bag released.'};
  }
}
