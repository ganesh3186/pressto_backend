import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {Challan, ChallanStatus} from '../models/challan.model';
import {ChallanRepository, OrderRepository} from '../repositories';
import {OrderService} from '../services/order.service';
import {StoreScopeService} from '../services/store-scope.service';

export class ChallanController {
  constructor(
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @inject('services.order') private orderService: OrderService,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Generate Challan ─────────────────────────────────────────────────────
  // Creates a challan snapshot for an order (at intake / on demand). Order
  // creation already does this automatically (OrderService.createOrder) — this
  // endpoint exists for the rare case a challan needs to be (re)generated
  // manually. Only one active challan per order at a time either way.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/challan/generate')
  @response(200, {description: 'Challan generated'})
  async generate(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const existing = await this.challanRepo.findOne({
      where: {orderId, status: {nin: [ChallanStatus.CONVERTED_TO_INVOICE]}} as any,
    });
    const challan = await this.orderService.generateChallanForOrder(orderId, currentUser[securityId]);

    return {
      message: existing ? 'Challan already exists for this order.' : 'Challan generated.',
      challan,
    };
  }

  // ─── Get Challan ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/challan')
  @response(200, {description: 'Challan for an order'})
  async getByOrder(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const challan = await this.challanRepo.findOne({
      where: {orderId},
      order: ['createdAt DESC'],
    } as any);

    if (!challan) throw new HttpErrors.NotFound('No challan found for this order.');
    return {challan};
  }

  // ─── Mark Printed ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{orderId}/challan/print')
  @response(200, {description: 'Challan marked as printed'})
  async markPrinted(@param.path.string('orderId') orderId: string): Promise<object> {
    const challan = await this.challanRepo.findOne({where: {orderId}} as any);
    if (!challan) throw new HttpErrors.NotFound('No challan found for this order.');

    await this.challanRepo.updateById(challan.id, {
      isPrinted: true,
      printedAt: new Date(),
      status: ChallanStatus.ISSUED,
    } as Partial<Challan>);

    return {message: 'Challan marked as printed.'};
  }
}
