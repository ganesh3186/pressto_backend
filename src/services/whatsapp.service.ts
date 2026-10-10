import {BindingScope, Getter, injectable} from '@loopback/core';
import {Options, repository} from '@loopback/repository';
import axios from 'axios';
import {Order, PaymentTransaction, PickupRequest} from '../models';
import {OrderStatus} from '../models/order-status.enum';
import {OrderType} from '../models/order-type.enum';
import {OrderDeliveryMethod} from '../models/order-delivery-method.enum';
import {PickupRequestStatus} from '../models/pickup-request-status.enum';
import type {
  CustomerRepository,
  CustomerPhoneRepository,
  OrderRepository,
  OrderItemRepository,
  ItemRepository,
  StoreRepository,
  PaymentTransactionRepository,
  PickupRequestRepository,
  InvoiceRepository,
} from '../repositories';

// Provider-approved names must remain byte-for-byte unchanged.
/* eslint-disable @typescript-eslint/naming-convention */
const TEMPLATES = {
  pulse_pickupreq: {parameters: 4, document: false},
  pulse_riderscheduled: {parameters: 4, document: false},
  pulse_ordercreated: {parameters: 5, document: true},
  pulse_paymentreceived: {parameters: 6, document: true},
  pulse_readyforcollection: {parameters: 5, document: false},
  pulse_deliveredcomplete: {parameters: 6, document: true},
  pulse_collectedcomplete: {parameters: 5, document: true},
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

/** Defers notifications until commit; rollback never runs the callback. */
export function afterWhatsAppCommit(
  options: Options | undefined,
  task: () => Promise<unknown>,
): void {
  const dispatch = () => {
    Promise.resolve()
      .then(task)
      .catch(() => {
        console.error(
          '[WhatsAppService] Could not prepare customer notification.',
        );
      });
  };
  const transaction = options?.transaction as
    | {
        observe?: (
          event: string,
          listener: (context: unknown, next: () => void) => void,
        ) => void;
      }
    | undefined;
  if (!transaction) {
    dispatch();
    return;
  }
  if (typeof transaction.observe !== 'function') {
    console.error(
      '[WhatsAppService] Unsupported transaction; notification skipped.',
    );
    return;
  }
  transaction.observe('after commit', (_context, next) => {
    dispatch();
    next();
  });
}

/** One customer-only Tata Omni transport and template preparation service. */
@injectable({scope: BindingScope.SINGLETON})
export class WhatsAppService {
  private readonly sent = new Map<string, number>();
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
    @repository.getter('ItemRepository')
    private getItems: Getter<ItemRepository>,
    @repository.getter('StoreRepository')
    private getStores: Getter<StoreRepository>,
    @repository.getter('PaymentTransactionRepository')
    private getPayments: Getter<PaymentTransactionRepository>,
    @repository.getter('PickupRequestRepository')
    private getPickups: Getter<PickupRequestRepository>,
    @repository.getter('InvoiceRepository')
    private getInvoices: Getter<InvoiceRepository>,
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
      name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
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

  private async items(orderId: string): Promise<string> {
    const rows = await (await this.getOrderItems()).find({where: {orderId}});
    if (!rows.length) return 'No items';
    const items = await (
      await this.getItems()
    ).find({where: {id: {inq: [...new Set(rows.map(r => r.itemId))]}}});
    const names = new Map(items.map(i => [i.id, i.name]));
    return rows
      .map(r => String(r.quantity) + ' x ' + (names.get(r.itemId) ?? 'Item'))
      .join(', ');
  }

  private async document(
    kind: 'TICKET' | 'RECEIPT' | 'INVOICE',
    order: Order,
    paymentId = '',
  ): Promise<WhatsAppTemplateMedia | undefined> {
    const pattern =
      process.env['WHATSAPP_' + kind + '_DOCUMENT_URL_TEMPLATE']?.trim();
    if (!pattern) return undefined;
    let invoiceId = '';
    if (pattern.includes('{invoiceId}')) {
      const invoice = await (
        await this.getInvoices()
      ).findOne({where: {orderId: order.id}, order: ['createdAt DESC']});
      invoiceId = invoice?.id ?? '';
      if (!invoiceId) return undefined;
    }
    const url = pattern
      .split('{orderId}')
      .join(encodeURIComponent(order.id))
      .split('{paymentId}')
      .join(encodeURIComponent(paymentId))
      .split('{invoiceId}')
      .join(encodeURIComponent(invoiceId));
    if (/\{[^}]+\}/.test(url) || (kind === 'RECEIPT' && !paymentId))
      return undefined;
    try {
      if (new URL(url).protocol !== 'https:') return undefined;
    } catch {
      return undefined;
    }
    return {
      type: 'document',
      url,
      fileName: kind.toLowerCase() + '-' + order.orderNumber + '.pdf',
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
    if (spec.document && !input.media) {
      this.warnOnce(
        input.templateId,
        '[WhatsAppService] ' +
          input.templateId +
          ' skipped: document URL/header configuration required.',
      );
      return false;
    }
    if (input.media) {
      try {
        if (new URL(input.media.url).protocol !== 'https:') return false;
      } catch {
        return false;
      }
    }
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
        typeof (response.data as {id?: unknown})?.id === 'string';
      if (!accepted)
        console.error(
          '[WhatsAppService] Template ' +
            input.templateId +
            ' rejected; HTTP ' +
            response.status +
            '.',
        );
      return accepted;
    } catch {
      console.error(
        '[WhatsAppService] Template ' + input.templateId + ' transport failed.',
      );
      return false;
    }
  }

  private async once(
    key: string,
    prepare: () => Promise<SendWhatsAppTemplateInput | undefined>,
  ) {
    if (!this.configured()) return;
    const cutoff = Date.now() - 86400000;
    for (const [id, time] of this.sent) if (time < cutoff) this.sent.delete(id);
    if (this.sent.has(key)) return;
    if (this.sent.size >= 10000)
      this.sent.delete(this.sent.keys().next().value!);
    this.sent.set(key, Date.now());
    try {
      const message = await prepare();
      if (!message || !(await this.sendTemplateMessage(message)))
        this.sent.delete(key);
    } catch {
      this.sent.delete(key);
      console.error(
        '[WhatsAppService] Could not prepare template notification.',
      );
    }
  }

  async notifyOrder(
    orderId: string,
    event: 'created' | 'ready' | 'delivered' | 'collected',
  ) {
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
        const items = await this.items(order.id);
        if (event === 'created')
          return {
            to: recipient.to,
            templateId: 'pulse_ordercreated',
            bodyParams: [
              recipient.name,
              order.orderNumber,
              items,
              this.money(order.totalAmount),
              this.date(order.deliveryDate),
            ],
            media: await this.document('TICKET', order),
          };
        const due = await this.balance(order);
        if (event === 'ready') {
          const store = await (await this.getStores()).findById(order.storeId);
          return {
            to: recipient.to,
            templateId: 'pulse_readyforcollection',
            bodyParams: [
              recipient.name,
              order.orderNumber,
              items,
              this.money(due),
              store.name,
            ],
          };
        }
        const collected =
          event === 'collected' ||
          order.deliveryMethod === OrderDeliveryMethod.STORE_PICKUP ||
          (!order.deliveryMethod &&
            [OrderType.STORE_DROPOFF, OrderType.HOME_PICKUP].includes(
              order.orderType,
            ));
        const bodyParams = [recipient.name, order.orderNumber, items];
        if (!collected) bodyParams.push(this.date(new Date()));
        bodyParams.push(
          this.money(order.totalAmount),
          due > 0 ? 'Balance due: INR ' + this.money(due) : 'Paid',
        );
        return {
          to: recipient.to,
          templateId: collected
            ? 'pulse_collectedcomplete'
            : 'pulse_deliveredcomplete',
          bodyParams,
          media: await this.document('INVOICE', order),
        };
      },
    );
  }

  async notifyPayment(payment: PaymentTransaction) {
    if (payment.transactionType === 'refund' || Number(payment.amount) <= 0)
      return;
    await this.once('payment:' + payment.id, async () => {
      const order = await (
        await this.getOrders()
      ).findOne({where: {id: payment.orderId, isDeleted: false}});
      if (!order) return undefined;
      const recipient = await this.customer(order.customerId);
      if (!recipient) return undefined;
      return {
        to: recipient.to,
        templateId: 'pulse_paymentreceived',
        bodyParams: [
          recipient.name,
          order.orderNumber,
          this.money(payment.amount),
          payment.paymentMode.replace(/_/g, ' '),
          payment.transactionReference?.trim()
            ? payment.transactionReference
            : payment.id,
          this.money(await this.balance(order)),
        ],
        media: await this.document('RECEIPT', order, payment.id),
      };
    });
  }

  async notifyPickup(
    pickupId: string,
    event: 'created' | 'scheduled',
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
        if (event === 'scheduled') {
          if (!pickup.assignedRiderId || !pickup.assignedRiderName)
            return undefined;
          // Approved wording says "today"; don't send it for a future pickup.
          if (this.date(pickup.requestedDate) !== this.date(new Date()))
            return undefined;
          return {
            to: recipient.to,
            templateId: 'pulse_riderscheduled',
            bodyParams: [
              recipient.name,
              pickup.pickupNumber ?? pickup.id,
              pickup.slot,
              pickup.assignedRiderName,
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
