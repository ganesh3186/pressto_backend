import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, patch, post, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ChallanStatus} from '../models/challan.model';
import {OrderStatus} from '../models/order-status.enum';
import {Invoice, InvoiceStatus} from '../models/invoice.model';
import {
  ChallanRepository,
  InvoiceRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentTransactionRepository,
} from '../repositories';
import {StoreScopeService} from '../services/store-scope.service';

export class InvoiceController {
  constructor(
    @repository(InvoiceRepository) private invoiceRepo: InvoiceRepository,
    @repository(ChallanRepository) private challanRepo: ChallanRepository,
    @repository(OrderRepository) private orderRepo: OrderRepository,
    @repository(OrderItemRepository) private orderItemRepo: OrderItemRepository,
    @repository(PaymentTransactionRepository) private paymentRepo: PaymentTransactionRepository,
    @inject('services.store-scope') private storeScopeService: StoreScopeService,
  ) {}

  // ─── Generate Invoice ─────────────────────────────────────────────────────
  // Converts the order's challan into a final invoice.
  // Takes a snapshot of the current order items (may differ from challan
  // if upgrades / returns happened after challan was issued).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/orders/{orderId}/invoice/generate')
  @response(200, {description: 'Invoice generated'})
  async generate(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('orderId') orderId: string,
  ): Promise<object> {
    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const ALLOWED_STATUSES = [
      OrderStatus.READY,
      OrderStatus.PARTIALLY_DISPATCHED,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ];
    if (!ALLOWED_STATUSES.includes(order.status as OrderStatus)) {
      throw new HttpErrors.BadRequest('Invoice can only be generated after processing and quality checks are complete (status must be ready or beyond).');
    }

    // Guard: only one invoice per order
    const existingInvoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (existingInvoice) {
      return {message: 'Invoice already exists for this order.', invoice: existingInvoice};
    }

    // Snapshot current order items
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
    const gstRate = 0.09;
    const cgst = parseFloat((subtotal * gstRate).toFixed(2));
    const sgst = parseFloat((subtotal * gstRate).toFixed(2));
    const discount = Number(order.discountAmount) || 0;
    // Final total is a whole rupee (≥ .5 rounds up); components keep decimals.
    const totalAmount = Math.round(subtotal - discount + cgst + sgst);

    // Sum all payment transactions for this order
    const payments = await this.paymentRepo.find({where: {orderId}} as any);
    const amountReceived = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const balanceDue = parseFloat(Math.max(0, totalAmount - amountReceived).toFixed(2));

    // Generate invoice number: INV-YYYYMM-00001
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.invoiceRepo.count();
    const invoiceNumber = `INV-${ym}-${String(count.count + 1).padStart(5, '0')}`;

    const {v4} = await import('uuid');

    // Find the challan to link and mark it converted
    const challan = await this.challanRepo.findOne({where: {orderId}} as any);
    if (challan) {
      await this.challanRepo.updateById(challan.id, {status: ChallanStatus.CONVERTED_TO_INVOICE});
    }

    const invoice = await this.invoiceRepo.create({
      id: v4(),
      orderId,
      challanId: challan?.id,
      invoiceNumber,
      generatedBy: currentUser[securityId],
      items,
      subtotal: parseFloat(Number(subtotal).toFixed(2)),
      discount,
      deliveryCharge: 0,
      cgst,
      sgst,
      totalAmount,
      amountReceived: parseFloat(amountReceived.toFixed(2)),
      balanceDue,
      status: InvoiceStatus.ISSUED,
    } as Partial<Invoice>);

    return {message: 'Invoice generated.', invoice};
  }

  // ─── Get Invoice ──────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/invoice')
  @response(200, {description: 'Invoice for an order'})
  async getByOrder(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const order = await this.orderRepo.findOne({where: {id: orderId, isDeleted: false}});
    if (!order) throw new HttpErrors.NotFound('Order not found.');

    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (!invoice) throw new HttpErrors.NotFound('No invoice found for this order.');

    return {invoice};
  }

  // ─── Mark Printed ─────────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @patch('/orders/{orderId}/invoice/print')
  @response(200, {description: 'Invoice marked as printed'})
  async markPrinted(@param.path.string('orderId') orderId: string): Promise<object> {
    const invoice = await this.invoiceRepo.findOne({where: {orderId}} as any);
    if (!invoice) throw new HttpErrors.NotFound('No invoice found for this order.');

    await this.invoiceRepo.updateById(invoice.id, {
      isPrinted: true,
      printedAt: new Date(),
    } as Partial<Invoice>);

    return {message: 'Invoice marked as printed.'};
  }
}
