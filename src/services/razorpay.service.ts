import {BindingScope, inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import Razorpay from 'razorpay';
import {GatewayPaymentLink} from '../models/gateway-payment-link.model';
import {GatewayPaymentLinkStatus} from '../models/gateway-payment-link-status.enum';
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {
  GatewayPaymentLinkRepository,
  SecurityDepositTopupRequestRepository,
  WalletRechargeRequestRepository,
} from '../repositories';
import {OrderService} from './order.service';
import {SecurityDepositService} from './security-deposit.service';
import {WalletService} from './wallet.service';

export interface CreatePaymentLinkInput {
  amount: number;
  description: string;
  referenceType: GatewayPaymentReferenceType;
  referenceId: string;
  customer: {name: string; email?: string; contact?: string};
  createdBy?: string;
}

/**
 * Everything Razorpay-specific lives here — the one place that knows how
 * to call Razorpay's API and verify its webhooks. Each PGLink entry point
 * (order payment, wallet top-up, security deposit top-up) only ever
 * touches createPaymentLink()/fetchLinkStatus(); the webhook controller is
 * the only caller of verifyWebhookSignature()/handlePaymentLinkPaid().
 *
 * The payment is never applied at link-creation time — only
 * handlePaymentLinkPaid() (called from the signature-verified webhook,
 * never from the client) actually credits anything, by calling straight
 * into whichever existing service already owns that flow
 * (OrderService.addPayment, WalletService.confirmRecharge,
 * SecurityDepositService.confirmTopup) — no gateway-specific payment logic
 * is duplicated here.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class RazorpayService {
  private client: Razorpay;

  constructor(
    @repository(GatewayPaymentLinkRepository)
    private gatewayPaymentLinkRepo: GatewayPaymentLinkRepository,
    @repository(WalletRechargeRequestRepository)
    private walletRechargeRequestRepo: WalletRechargeRequestRepository,
    @repository(SecurityDepositTopupRequestRepository)
    private securityDepositTopupRequestRepo: SecurityDepositTopupRequestRepository,
    @inject('services.order') private orderService: OrderService,
    @inject('services.wallet') private walletService: WalletService,
    @inject('services.security-deposit') private securityDepositService: SecurityDepositService,
  ) {
    this.client = new Razorpay({
      // Razorpay's own SDK field names — snake_case is their API's shape,
      // not this codebase's convention (mirrors the same suppress-comment
      // pattern already used in email.service.ts for a third-party shape).
      /* eslint-disable @typescript-eslint/naming-convention */
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
      /* eslint-enable @typescript-eslint/naming-convention */
    });
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink> {
    if (!(input.amount > 0)) {
      throw new HttpErrors.BadRequest('Amount must be greater than zero.');
    }

    const link = await this.client.paymentLink.create({
      // Razorpay wants the smallest currency unit (paise), same convention
      // as every other amount this codebase already stores in rupees.
      amount: Math.round(input.amount * 100),
      currency: 'INR',
      description: input.description,
      customer: input.customer,
      notify: {sms: false, email: false},
      // eslint-disable-next-line @typescript-eslint/naming-convention
      reminder_enable: false,
      // Our own traceability on Razorpay's side — mirrors what the create
      // request already carries, useful when looking a payment up from
      // the Razorpay dashboard during support/reconciliation.
      notes: {referenceType: input.referenceType, referenceId: input.referenceId},
    });

    const {v4} = await import('uuid');
    return this.gatewayPaymentLinkRepo.create({
      id: v4(),
      razorpayLinkId: link.id,
      razorpayShortUrl: link.short_url,
      amount: input.amount,
      status: GatewayPaymentLinkStatus.CREATED,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdBy: input.createdBy,
    });
  }

  /**
   * Raw HMAC-SHA256 check over the UNPARSED request body — Razorpay's own
   * SDK helper, not reimplemented here. Must be called with the literal
   * raw bytes/string the request arrived with, before any JSON.parse.
   */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    return Razorpay.validateWebhookSignature(rawBody, signature, secret);
  }

  /**
   * Called only after the webhook's signature has already been verified.
   * Idempotent — a redelivered webhook for an already-`paid` link is a
   * no-op, since Razorpay retries webhooks that don't get a 2xx quickly.
   */
  async handlePaymentLinkPaid(payload: {
    razorpayLinkId: string;
    razorpayPaymentId: string;
    rawPayload: object;
  }): Promise<void> {
    const link = await this.gatewayPaymentLinkRepo.findOne({
      where: {razorpayLinkId: payload.razorpayLinkId} as object,
    });
    if (!link) {
      // Not one of ours (or already deleted) — nothing to apply. Not an
      // error: Razorpay sends this webhook for every payment link on the
      // account, including ones this service didn't create.
      return;
    }
    if (link.status === GatewayPaymentLinkStatus.PAID) return;

    let applicationError: string | undefined;
    try {
      await this.applyPayment(link, payload.razorpayPaymentId);
    } catch (err) {
      // The money genuinely arrived at Razorpay even if applying it here
      // failed (e.g. the order's balance changed in between) — never lose
      // that fact. Still marked `paid` below; the error is recorded for
      // manual reconciliation instead of silently disappearing.
      applicationError = err instanceof Error ? err.message : String(err);
    }

    await this.gatewayPaymentLinkRepo.updateById(link.id, {
      status: GatewayPaymentLinkStatus.PAID,
      paidAt: new Date(),
      rawWebhookPayload: payload.rawPayload,
      applicationError,
    });
  }

  private async applyPayment(link: GatewayPaymentLink, razorpayPaymentId: string): Promise<void> {
    switch (link.referenceType) {
      case GatewayPaymentReferenceType.ORDER_PAYMENT: {
        await this.orderService.addPayment(
          link.referenceId,
          {paymentMode: PaymentMode.GATEWAY, amount: link.amount, transactionReference: razorpayPaymentId},
          0,
          'system',
        );
        return;
      }
      case GatewayPaymentReferenceType.WALLET_TOPUP: {
        const request = await this.walletRechargeRequestRepo.findById(link.referenceId);
        await this.walletService.confirmRecharge(link.referenceId, request.customerId, razorpayPaymentId);
        return;
      }
      case GatewayPaymentReferenceType.SECURITY_DEPOSIT_TOPUP: {
        const request = await this.securityDepositTopupRequestRepo.findById(link.referenceId);
        await this.securityDepositService.confirmTopup(link.referenceId, request.customerId, razorpayPaymentId);
        return;
      }
      default:
        throw new Error(`Unknown gateway payment reference type: ${link.referenceType}`);
    }
  }
}
