import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {Challan, ChallanStatus} from '../models/challan.model';
import {
  ChallanRepository,
  GarmentRepository,
  OrderItemRepository,
  OrderRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

export class ChallanController {
  constructor(
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(GarmentRepository) private garmentRepo: GarmentRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Generate Challan ─────────────────────────────────────────────────────
  // Creates a challan snapshot for an order (at intake / on demand).
  // Only one active challan per order at a time.

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
    if (existing) {
      return {message: 'Challan already exists for this order.', challan: existing};
    }

    const orderItems = await this.orderItemRepo.find({where: {orderId}});
    const items = orderItems.map(oi => ({
      orderItemId: oi.id,
      serviceId: oi.serviceId,
      itemId: oi.itemId,
      quantity: Number(oi.quantity) || 0,
      // Postgres numeric columns come back as strings — coerce so downstream
      // math sums numerically instead of concatenating.
      unitPrice: Number(oi.unitPrice) || 0,
      totalPrice: Number(oi.totalPrice) || 0,
      additionalServiceIds: oi.additionalServiceIds ?? [],
    }));

    const subtotal = items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0);
    const gstRate = 0.09; // 9% CGST + 9% SGST
    const cgst = parseFloat((subtotal * gstRate).toFixed(2));
    const sgst = parseFloat((subtotal * gstRate).toFixed(2));
    const discount = Number(order.discountAmount) || 0;
    // Final total is a whole rupee (≥ .5 rounds up); components keep decimals.
    const totalAmount = Math.round(subtotal - discount + cgst + sgst);

    const totalCount = await this.challanRepo.count();
    const challanNumber = `CHL-${String(totalCount.count + 1).padStart(6, '0')}`;

    const {v4} = await import('uuid');
    const challan = await this.challanRepo.create({
      id: v4(),
      orderId,
      challanNumber,
      generatedBy: currentUser[securityId],
      items,
      subtotal: parseFloat(subtotal.toFixed(2)),
      discount,
      deliveryCharge: 0,
      cgst,
      sgst,
      totalAmount,
      status: ChallanStatus.ISSUED,
    } as Partial<Challan>);

    return {message: 'Challan generated.', challan};
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
