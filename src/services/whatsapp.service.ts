import {BindingScope, Getter, inject, injectable} from '@loopback/core';
import {OrderSummaryPdfService} from './order-summary-pdf.service';
import {repository} from '@loopback/repository';
import axios from 'axios';
import {Order, PaymentTransaction, PickupRequest} from '../models';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {OrderDeliveryMethod} from '../models/order-delivery-method.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import {GatewayPaymentLink} from '../models/gateway-payment-link.model';
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {GatewayPaymentLinkStatus} from '../models/gateway-payment-link-status.enum';
import {DeliveryStatus} from '../models/delivery-status.enum';
import {DeliveryOrderStatus} from '../models/delivery-order-status.enum';
import {ApprovalRequestStatus} from '../models/approval-request-status.enum';
import {CUSTOMER_ACTIONS_BY_TYPE} from '../models/approval-request.model';
import {ApprovalRequestType} from '../models/approval-request-type.enum';
import {GarmentStatus} from '../models/garment-status.enum';
import type {OrderService} from './order.service';
import type {RazorpayService} from './razorpay.service';
import type {ApprovalService} from './approval.service';
import type {
  CustomerRepository,
  CustomerPhoneRepository,
  OrderRepository,
  OrderItemRepository,
  StoreRepository,
  PaymentTransactionRepository,
  PickupRequestRepository,
  PickupDeliverySlotRepository,
  InvoiceRepository,
  InvoiceOrderLinkRepository,
  OrderHandoverRepository,
  RiderRepository,
  UsersRepository,
  DeliveryRepository,
  DeliveryOrderRepository,
  ApprovalRequestRepository,
  GarmentRepository,
  ItemRepository,
} from '../repositories';

// Provider-approved names must remain byte-for-byte unchanged.
/* eslint-disable @typescript-eslint/naming-convention */
const TEMPLATES = {
  pulse_pickupreq: {parameters: 4, document: false},
  pulse_rider_scheduled_221026: {parameters: 4, document: false},
  pulse_order_created_221026: {parameters: 5, document: true},
  pulse_payment_received_manual_221026: {parameters: 5, document: true},
  pulse_ready_for_collection_automatic_221026: {parameters: 5, document: false},
  pulse_delivery_by_rider_complete_221026: {parameters: 6, document: false},
  pulse_delivery_to_customer_complete_221026: {parameters: 5, document: false},
  pulse_wallet_recharge_221026: {parameters: 4, document: false},
  // V2's visible body has four placeholders; its support number is static text.
  pulse_wallet_redeem_221026: {parameters: 4, document: false},
  pulse_paymentlink_221026: {parameters: 5, document: false},
  pulse_login_otp_221026: {parameters: 1, document: false},
  pulse_rider_pickup_done_221026: {parameters: 4, document: false},
  pulse_ready_to_deliver_with_rider_details_221026: {
    parameters: 4,
    document: true,
  },
  pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026: {
    parameters: 6,
    document: true,
  },
  pulse_cust_approval_221026: {parameters: 5, document: false},
} as const;
/* eslint-enable @typescript-eslint/naming-convention */
export type CustomerWhatsAppTemplate = keyof typeof TEMPLATES;
export interface WhatsAppTemplateMedia {
  type: 'document';
  url: string;
  fileName?: string;
}
export interface SendWhatsAppTemplateInput {
  to: string;
  templateId: CustomerWhatsAppTemplate;
  bodyParams: string[];
  media?: WhatsAppTemplateMedia;
}

export interface WalletWhatsAppNotification {
  transactionId: string;
  customerId: string;
  amount: number;
  balance: number;
  date: Date | string;
  orderId?: string;
}

/** Business flows call this after their writes/transaction commit succeed. */
export function dispatchWhatsApp(task: () => Promise<unknown>): void {
  Promise.resolve()
    .then(task)
    .catch(() => {
      console.error(
        '[WhatsAppService] Could not prepare customer notification.',
      );
    });
}

/** One customer-only Tata Omni transport and template preparation service. */
@injectable({scope: BindingScope.SINGLETON})
export class WhatsAppService {
  private readonly sent = new Map<string, number>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly warned = new Set<string>();
  constructor(
    @repository.getter('CustomerRepository')
    private getCustomers: Getter<CustomerRepository>,
    @repository.getter('CustomerPhoneRepository')
    private getPhones: Getter<CustomerPhoneRepository>,
    @repository.getter('OrderRepository')
    private getOrders: Getter<OrderRepository>,
    @repository.getter('OrderItemRepository')
    private getOrderItems: Getter<OrderItemRepository>,
    @repository.getter('StoreRepository')
    private getStores: Getter<StoreRepository>,
    @repository.getter('PaymentTransactionRepository')
    private getPayments: Getter<PaymentTransactionRepository>,
    @repository.getter('PickupRequestRepository')
    private getPickups: Getter<PickupRequestRepository>,
    @repository.getter('InvoiceRepository')
    private getInvoices: Getter<InvoiceRepository>,
    @repository.getter('PickupDeliverySlotRepository')
    private getPickupSlots: Getter<PickupDeliverySlotRepository>,
    @inject('services.order-summary-pdf')
    private orderSummaries: OrderSummaryPdfService,
    @repository.getter('InvoiceOrderLinkRepository')
    private getInvoiceLinks: Getter<InvoiceOrderLinkRepository>,
    @repository.getter('OrderHandoverRepository')
    private getHandovers: Getter<OrderHandoverRepository>,
    @repository.getter('RiderRepository')
    private getRiders: Getter<RiderRepository>,
    @repository.getter('UsersRepository')
    private getUsers: Getter<UsersRepository>,
    @repository.getter('DeliveryRepository')
    private getDeliveries: Getter<DeliveryRepository>,
    @repository.getter('DeliveryOrderRepository')
    private getDeliveryOrders: Getter<DeliveryOrderRepository>,
    @repository.getter('ApprovalRequestRepository')
    private getApprovals: Getter<ApprovalRequestRepository>,
    @repository.getter('GarmentRepository')
    private getGarments: Getter<GarmentRepository>,
    @repository.getter('ItemRepository')
    private getItems: Getter<ItemRepository>,
    @inject.getter('services.order')
    private getOrderService: Getter<OrderService>,
    @inject.getter('services.razorpay')
    private getRazorpayService: Getter<RazorpayService>,
    @inject.getter('services.approval')
    private getApprovalService: Getter<ApprovalService>,
  ) {}

  private warnOnce(key: string, message: string) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      console.warn(message);
    }
  }

  private configured(): boolean {
    if (process.env.WHATSAPP_ENABLED === 'false') return false;
    if (process.env.WHATSAPP_ACCESS_TOKEN?.trim()) return true;
    this.warnOnce(
      'credentials',
      '[WhatsAppService] WHATSAPP_ACCESS_TOKEN missing; sends disabled.',
    );
    return false;
  }

  private attachmentsEnabled(): boolean {
    return process.env.WHATSAPP_ATTACHMENTS_ENABLED === 'true';
  }

  private phone(number: string, countryCode = '+91'): string | undefined {
    const input = number.trim();
    if (!/^[+\d\s()-]+$/.test(input)) return undefined;
    const digits = input.replace(/\D/g, '');
    const code = countryCode.replace(/\D/g, '');
    const result = input.startsWith('+')
      ? digits
      : digits.startsWith('00')
        ? digits.slice(2)
        : digits.length === 10
          ? code + digits
          : digits;
    return /^[1-9]\d{7,14}$/.test(result) ? '+' + result : undefined;
  }

  private async customer(customerId: string) {
    const customer = await (
      await this.getCustomers()
    ).findOne({where: {id: customerId, isDeleted: false}});
    if (!customer) return undefined;
    // A saved contact/rider/employee phone must never become the recipient.
    const phones = await (
      await this.getPhones()
    ).find({
      where: {
        customerId,
        isDeleted: false,
        isActive: true,
        isWhatsappNumber: true,
      },
      order: ['isPrimary DESC', 'createdAt ASC'],
    });
    const selected = phones.find(p => this.phone(p.phone, p.countryCode));
    if (!selected) return undefined;
    return {
      name: customer.firstName.trim(),
      to: this.phone(selected.phone, selected.countryCode)!,
    };
  }

  private date(value: Date | string | undefined): string {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not scheduled'
      : date.toLocaleDateString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });
  }

  private money(value: unknown): string {
    return (Number(value) || 0).toFixed(2);
  }

  private currency(value: unknown): string {
    return (
      '₹' +
      (Number(value) || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  private dateTime(value: Date | string | undefined): string {
    if (!value || Number.isNaN(new Date(value).getTime())) return '';
    return new Date(value).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  private storeCollection(order: Order): boolean {
    return order.deliveryMethod
      ? order.deliveryMethod === OrderDeliveryMethod.STORE_PICKUP
      : [OrderType.STORE_DROPOFF, OrderType.HOME_PICKUP].includes(
          order.orderType,
        );
  }

  private async balance(order: Order): Promise<number> {
    const payments = await (
      await this.getPayments()
    ).find({where: {orderId: order.id}});
    // Match split-order accounting: parent raw payments were superseded by allocation.
    const direct =
      order.hasBeenSplit && !order.parentOrderId
        ? 0
        : payments.reduce(
            (total, p) =>
              total + (p.transactionType === 'refund' ? 0 : Number(p.amount)),
            0,
          );
    return Math.max(
      0,
      Number(order.totalAmount ?? 0) -
        Number(order.allocatedPayment ?? 0) -
        direct,
    );
  }

  private async itemCount(orderId: string): Promise<string> {
    const rows = await (await this.getOrderItems()).find({where: {orderId}});
    return String(
      rows.reduce(
        (count, row) =>
          count +
          (row.rejectedAtIntake ? 0 : Math.max(0, Number(row.quantity) || 0)),
        0,
      ),
    );
  }

  private async invoice(orderId: string) {
    const invoices = await this.getInvoices();
    const direct = await invoices.findOne({
      where: {orderId},
      order: ['createdAt DESC'],
    });
    if (direct) return direct;
    const link = await (
      await this.getInvoiceLinks()
    ).findOne({where: {orderId}});
    return link ? invoices.findOne({where: {id: link.invoiceId}}) : null;
  }

  private documentUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }

  private async invoiceDocument(
    order: Order,
    invoiceId: string,
  ): Promise<WhatsAppTemplateMedia> {
    const url = await this.orderSummaries.createForInvoice(order.id, invoiceId);
    return {
      type: 'document',
      url,
      fileName: 'invoice-' + order.orderNumber + '.pdf',
    };
  }

  /** HTTP acceptance only, not proof of delivery. Never logs tokens, payloads or customer phones. */
  async sendTemplateMessage(
    input: SendWhatsAppTemplateInput,
  ): Promise<boolean> {
    if (!this.configured()) return false;
    const spec = TEMPLATES[input.templateId];
    const to = this.phone(input.to);
    if (
      !spec ||
      !to ||
      input.bodyParams.length !== spec.parameters ||
      input.bodyParams.some(p => typeof p !== 'string' || !p.trim())
    )
      return false;
    // Attachment templates remain off until provider headers and PDFs are confirmed.
    if (spec.document && !this.attachmentsEnabled()) return false;
    // Text-only approved templates must never receive an unexpected media header.
    if (!spec.document && input.media) return false;
    if (spec.document && !input.media) {
      this.warnOnce(
        input.templateId,
        '[WhatsAppService] ' +
          input.templateId +
          ' skipped: document URL/header configuration required.',
      );
      return false;
    }
    if (input.media && !this.documentUrl(input.media.url)) return false;
    const components: object[] = [];
    if (input.media)
      components.push({
        type: 'header',
        parameters: [
          {
            type: 'document',
            document: {
              link: input.media.url,
              ...(input.media.fileName ? {filename: input.media.fileName} : {}),
            },
          },
        ],
      });
    components.push({
      type: 'body',
      parameters: input.bodyParams.map(text => ({type: 'text', text})),
    });
    if (input.templateId === 'pulse_login_otp_221026') {
      if (!/^\d{6}$/.test(input.bodyParams[0])) return false;
      components.push({
        type: 'button',
        // Provider payload field must keep its documented spelling.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        sub_type: 'url',
        index: '0',
        parameters: [{type: 'text', text: input.bodyParams[0]}],
      });
    }
    const apiUrl = process.env.WHATSAPP_API_URL?.trim();
    const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim();
    const requestConfig = {
      headers: {
        Authorization: 'Bearer ' + process.env.WHATSAPP_ACCESS_TOKEN!.trim(),
        'Content-Type': 'application/json',
      },
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true,
    };
    try {
      const response = await axios.post(
        apiUrl
          ? apiUrl
          : 'https://wb.omni.tatatelebusiness.com/whatsapp-cloud/messages',
        {
          to,
          type: 'template',
          source: 'external',
          template: {
            name: input.templateId,
            language: {
              code: language ? language : 'en',
            },
            components,
          },
        },
        requestConfig,
      );
      const accepted =
        response.status >= 200 &&
        response.status < 300 &&
        typeof (response.data as {id?: unknown})?.id === 'string' &&
        Boolean((response.data as {id: string}).id.trim());
      if (!accepted)
        console.error(
          '[WhatsAppService] Template ' +
            input.templateId +
            ' rejected; HTTP ' +
            response.status +
            '.',
        );
      else {
        const messageId = (response.data as {id: string}).id.trim();
        const safeId = /^[A-Za-z0-9._:-]{1,200}$/.test(messageId)
          ? messageId
          : '[unavailable]';
        console.info(
          '[WhatsAppService] Template ' +
            input.templateId +
            ' accepted; provider message ID ' +
            safeId +
            '. Delivery is not yet confirmed.',
        );
      }
      return accepted;
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;
      const safeCode = code && /^[A-Z_]{1,40}$/.test(code) ? code : 'UNKNOWN';
      console.error(
        '[WhatsAppService] Template ' +
          input.templateId +
          ' transport failed; code ' +
          safeCode +
          '.',
      );
      return false;
    }
  }

  private async once(
    key: string,
    prepare: () => Promise<SendWhatsAppTemplateInput | undefined>,
  ): Promise<boolean> {
    if (!this.configured()) return false;
    const cutoff = Date.now() - 86400000;
    for (const [id, time] of this.sent) if (time < cutoff) this.sent.delete(id);
    if (this.sent.has(key)) return true;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      try {
        const message = await prepare();
        if (!message || !(await this.sendTemplateMessage(message)))
          return false;
        if (this.sent.size >= 10000)
          this.sent.delete(this.sent.keys().next().value!);
        this.sent.set(key, Date.now());
        return true;
      } catch {
        console.error(
          '[WhatsAppService] Could not prepare template notification.',
        );
        return false;
      } finally {
        this.pending.delete(key);
      }
    });
    this.pending.set(key, task);
    return task;
  }

  async notifyWalletRecharge(
    input: WalletWhatsAppNotification,
  ): Promise<boolean> {
    if (!(input.amount > 0)) return false;
    return this.once('wallet-recharge:' + input.transactionId, async () => {
      const recipient = await this.customer(input.customerId);
      if (!recipient) return undefined;
      return {
        to: recipient.to,
        templateId: 'pulse_wallet_recharge_221026',
        bodyParams: [
          recipient.name,
          this.currency(input.amount),
          input.transactionId,
          this.currency(input.balance),
        ],
      };
    });
  }

  async notifyWalletRedeemed(
    input: WalletWhatsAppNotification,
  ): Promise<boolean> {
    // The approved wording is specifically for payment against a ticket.
    if (!(input.amount > 0) || !input.orderId) return false;
    return this.once('wallet-redeem:' + input.transactionId, async () => {
      const order = await (
        await this.getOrders()
      ).findOne({where: {id: input.orderId, isDeleted: false}});
      if (!order || order.customerId !== input.customerId) return undefined;
      const recipient = await this.customer(input.customerId);
      if (!recipient) return undefined;
      return {
        to: recipient.to,
        templateId: 'pulse_wallet_redeem_221026',
        bodyParams: [
          recipient.name,
          this.currency(input.amount),
          order.orderNumber,
          this.currency(input.balance),
        ],
      };
    });
  }

  async notifyPaymentLink(link: GatewayPaymentLink): Promise<boolean> {
    if (
      link.referenceType !== GatewayPaymentReferenceType.ORDER_PAYMENT ||
      link.status !== GatewayPaymentLinkStatus.CREATED ||
      !(Number(link.amount) > 0) ||
      !link.shortUrl ||
      !link.expiresAt ||
      !(new Date(link.expiresAt).getTime() > Date.now())
    )
      return false;
    try {
      if (new URL(link.shortUrl).protocol !== 'https:') return false;
    } catch {
      return false;
    }
    return this.once('payment-link:' + link.id, async () => {
      const order = await (
        await this.getOrders()
      ).findOne({where: {id: link.referenceId, isDeleted: false}});
      if (!order || order.status === OrderStatus.CANCELLED) return undefined;
      const recipient = await this.customer(order.customerId);
      if (!recipient) return undefined;
      return {
        to: recipient.to,
        templateId: 'pulse_paymentlink_221026',
        bodyParams: [
          recipient.name,
          order.orderNumber,
          this.currency(link.amount),
          link.shortUrl!,
          this.dateTime(link.expiresAt),
        ],
      };
    });
  }

  async notifyOrder(
    orderId: string,
    event: 'created' | 'ready' | 'delivered' | 'collected',
  ) {
    if (event === 'created' && !this.attachmentsEnabled()) return;
    await this.once(
      'order:' + orderId + ':' + (event === 'collected' ? 'delivered' : event),
      async () => {
        const order = await (
          await this.getOrders()
        ).findOne({where: {id: orderId, isDeleted: false}});
        if (
          !order ||
          order.status === OrderStatus.DRAFT ||
          order.status === OrderStatus.CANCELLED
        )
          return undefined;
        if (
          event === 'created' &&
          (Boolean(order.parentOrderId) || Boolean(order.reprocessOfOrderId))
        )
          return undefined;
        if (event === 'ready' && order.status !== OrderStatus.READY)
          return undefined;
        if (
          (event === 'delivered' || event === 'collected') &&
          order.status !== OrderStatus.DELIVERED
        )
          return undefined;
        const recipient = await this.customer(order.customerId);
        if (!recipient) return undefined;
        const store = await (await this.getStores()).findById(order.storeId);
        if (event === 'created') {
          const ticketUrl = await this.orderSummaries.createForOrder(order.id);
          return {
            to: recipient.to,
            templateId: 'pulse_order_created_221026',
            bodyParams: [
              recipient.name,
              store.name,
              order.orderNumber,
              await this.itemCount(order.id),
              this.date(order.deliveryDate),
            ],
            media: {
              type: 'document' as const,
              url: ticketUrl,
              fileName: 'ticket-' + order.orderNumber + '.pdf',
            },
          };
        }
        if (event === 'ready') {
          // V2's automatic collection message is for counter collection.
          // Rider-delivery assignment templates are a separate rollout.
          if (!this.storeCollection(order)) return undefined;
          const due = await this.balance(order);
          return {
            to: recipient.to,
            templateId: 'pulse_ready_for_collection_automatic_221026',
            bodyParams: [
              recipient.name,
              await this.itemCount(order.id),
              order.orderNumber,
              store.name,
              due > 0 ? this.currency(due) : 'Nil, already paid',
            ],
          };
        }
        const handover = await (
          await this.getHandovers()
        ).findOne({
          where: {orderId, isDeleted: false},
          order: ['handedOverAt DESC'],
        });
        // Completion templates promise the actual recipient and event time.
        // Never substitute the sender's current time or invent a collector.
        const completedAt = this.dateTime(
          handover?.handedOverAt ?? handover?.createdAt,
        );
        if (!handover?.collectorName?.trim() || !completedAt) {
          this.warnOnce(
            'handover-details',
            '[WhatsAppService] Saved handover recipient/time unavailable.',
          );
          return undefined;
        }
        const collected = event === 'collected' || this.storeCollection(order);
        if (collected)
          return {
            to: recipient.to,
            templateId: 'pulse_delivery_to_customer_complete_221026',
            bodyParams: [
              recipient.name,
              order.orderNumber,
              handover.collectorName,
              completedAt,
              store.name,
            ],
          };
        const actor = await (
          await this.getUsers()
        ).findOne({
          where: {id: handover.handedOverBy},
          fields: {fullName: true},
        });
        const actorName = actor?.fullName?.trim();
        const riderName = actorName?.length
          ? actorName
          : order.assignedRiderName?.trim();
        if (!riderName) return undefined;
        const supportPhone = process.env.WHATSAPP_SUPPORT_PHONE?.trim();
        return {
          to: recipient.to,
          templateId: 'pulse_delivery_by_rider_complete_221026',
          bodyParams: [
            recipient.name,
            order.orderNumber,
            riderName,
            handover.collectorName,
            completedAt,
            supportPhone?.length ? supportPhone : '1800229199',
          ],
        };
      },
    );
  }

  async notifyPayment(payment: PaymentTransaction) {
    if (!this.attachmentsEnabled()) return;
    if (payment.transactionType === 'refund' || Number(payment.amount) <= 0)
      return;
    await this.once('payment:' + payment.id, async () => {
      const order = await (
        await this.getOrders()
      ).findOne({where: {id: payment.orderId, isDeleted: false}});
      if (!order) return undefined;
      const recipient = await this.customer(order.customerId);
      if (!recipient) return undefined;
      const invoice = await this.invoice(order.id);
      if (!invoice?.invoiceNumber?.trim()) {
        this.warnOnce(
          'payment-invoice',
          '[WhatsAppService] Payment notification requires a generated invoice.',
        );
        return undefined;
      }
      return {
        to: recipient.to,
        templateId: 'pulse_payment_received_manual_221026',
        bodyParams: [
          recipient.name,
          this.money(payment.amount),
          order.orderNumber,
          payment.paymentMode.replace(/_/g, ' '),
          invoice.invoiceNumber,
        ],
        media: await this.invoiceDocument(order, invoice.id),
      };
    });
  }

  async notifyDeliveryAssigned(deliveryId: string): Promise<void> {
    if (!this.configured() || !this.attachmentsEnabled()) return;
    const delivery = await (
      await this.getDeliveries()
    ).findOne({
      where: {id: deliveryId, isDeleted: false},
    });
    if (!delivery || delivery.status !== DeliveryStatus.ASSIGNED) return;
    const stops = await (
      await this.getDeliveryOrders()
    ).find({
      where: {deliveryId},
    });
    for (const stop of stops) {
      if (stop.status && stop.status !== DeliveryOrderStatus.PENDING) continue;
      await this.once(
        'delivery-assigned:' + deliveryId + ':' + stop.orderId,
        async () => {
          const order = await (
            await this.getOrders()
          ).findOne({
            where: {id: stop.orderId, isDeleted: false},
          });
          // Ignore stale runs superseded by a different rider/schedule.
          if (
            !order ||
            !order.status ||
            order.assignedRiderId !== delivery.riderId ||
            order.deliveryMethod !== OrderDeliveryMethod.HOME_DELIVERY ||
            ![OrderStatus.READY, OrderStatus.PARTIALLY_DISPATCHED].includes(
              order.status,
            ) ||
            !order.deliveryDate ||
            !delivery.deliveryDate ||
            new Date(order.deliveryDate).getTime() !==
              new Date(delivery.deliveryDate).getTime() ||
            order.deliverySlot !== delivery.deliverySlot
          )
            return undefined;
          const recipient = await this.customer(order.customerId);
          if (!recipient) return undefined;
          let timeSlot = delivery.deliverySlot?.trim();
          if (delivery.deliverySlotId) {
            const slot = await (
              await this.getPickupSlots()
            ).findOne({
              where: {id: delivery.deliverySlotId, isDeleted: false},
            });
            timeSlot =
              slot?.startTime?.trim() && slot?.endTime?.trim()
                ? `${slot.startTime.trim()} - ${slot.endTime.trim()}`
                : undefined;
          }
          if (!timeSlot || !delivery.riderName?.trim()) return undefined;
          const params = [
            recipient.name,
            order.orderNumber,
            delivery.riderName,
            this.date(delivery.deliveryDate) + ', ' + timeSlot,
          ];
          const orderService = await this.getOrderService();
          const {due} = await orderService.computeBalanceDue(order);
          if (due <= 0) {
            if (!this.attachmentsEnabled()) return undefined;
            const invoice = await this.invoice(order.id);
            if (!invoice?.invoiceNumber?.trim()) {
              this.warnOnce(
                'delivery-invoice',
                '[WhatsAppService] Paid delivery assignment notification requires a generated invoice.',
              );
              return undefined;
            }
            const media = await this.invoiceDocument(order, invoice.id);
            return {
              to: recipient.to,
              templateId: 'pulse_ready_to_deliver_with_rider_details_221026',
              bodyParams: params,
              media,
            };
          }
          // Reuse the existing gateway operation, without also sending its
          // separate payment-link template. Never invent a payment URL.
          const invoice = await this.invoice(order.id);
          const media: WhatsAppTemplateMedia = invoice?.invoiceNumber?.trim()
            ? await this.invoiceDocument(order, invoice.id)
            : {
                type: 'document',
                url: await this.orderSummaries.createForChallan(order.id),
                fileName: 'challan-' + order.orderNumber + '.pdf',
              };
          const gateway = await this.getRazorpayService();
          const link = await gateway.createPaymentLink({
            referenceType: GatewayPaymentReferenceType.ORDER_PAYMENT,
            referenceId: order.id,
            amount: due,
            description: 'Payment for ticket ' + order.orderNumber,
            customer: {name: recipient.name, contact: recipient.to},
            createdBy: delivery.assignedBy,
          });
          if (
            !link.shortUrl ||
            !link.expiresAt ||
            new Date(link.expiresAt).getTime() <= Date.now() ||
            link.status !== GatewayPaymentLinkStatus.CREATED ||
            link.referenceId !== order.id ||
            link.referenceType !== GatewayPaymentReferenceType.ORDER_PAYMENT ||
            Number(link.amount) !== due ||
            !this.documentUrl(link.shortUrl) ||
            new URL(link.shortUrl).protocol !== 'https:'
          )
            return undefined;
          return {
            to: recipient.to,
            templateId:
              'pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026',
            bodyParams: [...params, this.currency(due), link.shortUrl],
            media,
          };
        },
      );
    }
  }

  async notifyCustomerApproval(requestId: string): Promise<boolean> {
    return this.once('customer-approval:' + requestId, async () => {
      const request = await (
        await this.getApprovals()
      ).findOne({where: {id: requestId}});
      if (
        !request ||
        request.status !== ApprovalRequestStatus.PENDING ||
        request.entityType !== 'garment' ||
        !CUSTOMER_ACTIONS_BY_TYPE[request.type]?.length
      )
        return undefined;
      const garment = await (
        await this.getGarments()
      ).findOne({
        where: {id: request.entityId, isDeleted: false},
      });
      if (!garment || garment.status !== GarmentStatus.ON_HOLD)
        return undefined;
      const item = await (
        await this.getOrderItems()
      ).findOne({where: {id: garment.orderItemId}});
      const order =
        item &&
        (await (
          await this.getOrders()
        ).findOne({
          where: {id: item.orderId, isDeleted: false},
        }));
      if (
        !item ||
        !order ||
        !order.status ||
        [
          OrderStatus.CANCELLED,
          OrderStatus.RETURNED,
          OrderStatus.DRAFT,
        ].includes(order.status)
      )
        return undefined;
      const recipient = await this.customer(order.customerId);
      if (!recipient) return undefined;
      const catalogItem = item.itemName?.trim()
        ? null
        : await (
            await this.getItems()
          ).findOne({
            where: {id: item.itemId},
          });
      const itemName = item.itemName?.trim()
        ? item.itemName.trim()
        : catalogItem?.name?.trim();
      if (!itemName || !request.requestReason?.trim()) return undefined;
      let additionalCharge = 'None';
      if (request.type === ApprovalRequestType.UPGRADE_SERVICE) {
        const service = await this.getApprovalService();
        // Same quote shown by the existing customer approval screen.
        const view = await service.getUpgradeView(request);
        const pricing = view.pricing as {difference?: unknown} | undefined;
        if (
          pricing?.difference == null ||
          !Number.isFinite(Number(pricing.difference))
        )
          return undefined;
        const difference = Number(pricing.difference);
        if (difference > 0) additionalCharge = this.currency(difference);
      }
      return {
        to: recipient.to,
        templateId: 'pulse_cust_approval_221026',
        bodyParams: [
          recipient.name,
          order.orderNumber,
          itemName,
          request.requestReason.trim(),
          additionalCharge,
        ],
      };
    });
  }

  async notifyPickup(
    pickupId: string,
    event: 'created' | 'scheduled' | 'completed',
    assignmentKey = '',
  ) {
    await this.once(
      'pickup:' + pickupId + ':' + event + ':' + assignmentKey,
      async () => {
        const pickup: PickupRequest | null = await (
          await this.getPickups()
        ).findOne({where: {id: pickupId, isDeleted: false}});
        if (
          !pickup ||
          pickup.status === PickupRequestStatus.NOT_SERVICEABLE ||
          pickup.status === PickupRequestStatus.CANCELLED
        )
          return undefined;
        // Guest pickup intake has no saved WhatsApp preference: do not assume its phone opted in.
        if (!pickup.customerId) return undefined;
        const recipient = await this.customer(pickup.customerId);
        if (!recipient) return undefined;
        if (event === 'completed') {
          if (
            pickup.status !== PickupRequestStatus.PICKED_UP ||
            !pickup.assignedRiderName?.trim() ||
            !pickup.actualItemsByService?.length
          )
            return undefined;
          const quantities = pickup.actualItemsByService.map(row =>
            Number(row.quantity),
          );
          if (
            quantities.some(
              quantity => !Number.isFinite(quantity) || quantity <= 0,
            )
          )
            return undefined;
          const count = quantities.reduce(
            (total, quantity) => total + quantity,
            0,
          );
          return {
            to: recipient.to,
            templateId: 'pulse_rider_pickup_done_221026',
            bodyParams: [
              recipient.name,
              pickup.assignedRiderName,
              pickup.pickupNumber ?? pickup.id,
              `${count} item${count === 1 ? '' : 's'}`,
            ],
          };
        }
        if (event === 'scheduled') {
          if (!pickup.assignedRiderId || !pickup.assignedRiderName)
            return undefined;
          // Approved wording says "today"; don't send it for a future pickup.
          if (this.date(pickup.requestedDate) !== this.date(new Date()))
            return undefined;
          const slot = pickup.pickupSlotId
            ? await (
                await this.getPickupSlots()
              ).findOne({
                where: {id: pickup.pickupSlotId, isDeleted: false},
              })
            : null;
          const timeSlot =
            slot?.startTime?.trim() && slot?.endTime?.trim()
              ? `${slot.startTime.trim()} - ${slot.endTime.trim()}`
              : '';
          if (!timeSlot) {
            this.warnOnce(
              'pickup-slot-times',
              '[WhatsAppService] Pickup slot start/end times unavailable.',
            );
            return undefined;
          }
          const rider = await (
            await this.getRiders()
          ).findOne({
            where: {id: pickup.assignedRiderId, isDeleted: false},
            fields: {userId: true},
          });
          const user = rider
            ? await (
                await this.getUsers()
              ).findOne({
                where: {id: rider.userId, isDeleted: false},
                fields: {countryCode: true, phone: true},
              })
            : null;
          const riderPhone = user?.phone
            ? this.phone(user.phone, user.countryCode)
            : undefined;
          if (!riderPhone) {
            this.warnOnce(
              'rider-phone',
              '[WhatsAppService] Assigned rider contact unavailable.',
            );
            return undefined;
          }
          return {
            to: recipient.to,
            templateId: 'pulse_rider_scheduled_221026',
            bodyParams: [
              recipient.name,
              pickup.assignedRiderName,
              riderPhone,
              timeSlot,
            ],
          };
        }
        return {
          to: recipient.to,
          templateId: 'pulse_pickupreq',
          bodyParams: [
            recipient.name,
            pickup.pickupNumber ?? pickup.id,
            pickup.address,
            this.date(pickup.requestedDate),
          ],
        };
      },
    );
  }
}
