import * as crypto from 'crypto';
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

export interface CreateGatewayOrderInput {
  amount: number;
  description: string;
  referenceType: GatewayPaymentReferenceType;
  referenceId: string;
  customer: {name: string; email?: string; contact?: string};
  createdBy?: string;
}

export interface VerifyGatewayPaymentInput {
  id: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/**
 * Everything Razorpay-specific lives here — the one place that knows how
 * to call Razorpay's API and verify its signatures. Each PGLink entry
 * point (order payment, wallet top-up, security deposit top-up) only ever
 * touches createOrder() to get an order id for the frontend's inline
 * Checkout popup; the controller is the only caller of
 * verifyAndApplyPayment() (the popup's own `handler` callback, right
 * after the customer pays) and handlePaymentCaptured() (the
 * `payment.captured` webhook — a fallback for when the browser never
 * gets to run the handler).
 *
 * The payment is never applied at order-creation time — only a
 * signature-verified confirmation (either path above) actually credits
 * anything, by calling straight into whichever existing service already
 * owns that flow (OrderService.addPayment, WalletService.confirmRecharge,
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

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayPaymentLink> {
    if (!(input.amount > 0)) {
      throw new HttpErrors.BadRequest('Amount must be greater than zero.');
    }

    const order = await this.client.orders.create({
      // Razorpay wants the smallest currency unit (paise), same convention
      // as every other amount this codebase already stores in rupees.
      amount: Math.round(input.amount * 100),
      currency: 'INR',
      // Our own traceability on Razorpay's side — mirrors what the create
      // request already carries, useful when looking a payment up from
      // the Razorpay dashboard during support/reconciliation.
      notes: {referenceType: input.referenceType, referenceId: input.referenceId},
    });

    const {v4} = await import('uuid');
    return this.gatewayPaymentLinkRepo.create({
      id: v4(),
      razorpayOrderId: order.id,
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
   * Called from the Checkout popup's own `handler` callback, immediately
   * after the customer pays — the primary confirmation path (synchronous,
   * no polling needed). Verifies Razorpay's per-payment signature
   * (HMAC-SHA256 of `order_id|payment_id` with the API key secret, per
   * Razorpay's documented Standard Checkout verification) before applying
   * anything. Idempotent against handlePaymentCaptured() also firing for
   * the same order (e.g. the browser closed before this ran) — whichever
   * gets there first applies the payment, the other is a no-op.
   */
  async verifyAndApplyPayment(input: VerifyGatewayPaymentInput): Promise<GatewayPaymentLink> {
    const link = await this.gatewayPaymentLinkRepo.findById(input.id);
    if (link.razorpayOrderId !== input.razorpayOrderId) {
      throw new HttpErrors.BadRequest('Order id does not match this payment link.');
    }
    if (link.status === GatewayPaymentLinkStatus.PAID) return link;

    const secret = process.env.RAZORPAY_KEY_SECRET ?? '';
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');
    if (expectedSignature !== input.razorpaySignature) {
      throw new HttpErrors.BadRequest('Invalid payment signature.');
    }

    return this.markPaidAndApply(link, input.razorpayPaymentId, {source: 'checkout-handler', ...input});
  }

  /**
   * Called only after the webhook's signature has already been verified.
   * Fallback for when the browser never gets to run the Checkout
   * `handler` (closed tab, network drop, a UPI intent that completes
   * later). Idempotent — a redelivered webhook, or one that lost the
   * race against verifyAndApplyPayment(), for an already-`paid` link is a
   * no-op.
   */
  async handlePaymentCaptured(payload: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    rawPayload: object;
  }): Promise<void> {
    const link = await this.gatewayPaymentLinkRepo.findOne({
      where: {razorpayOrderId: payload.razorpayOrderId} as object,
    });
    if (!link) {
      // Not one of ours (or already deleted) — nothing to apply. Not an
      // error: Razorpay sends this webhook for every order on the
      // account, including ones this service didn't create.
      return;
    }
    if (link.status === GatewayPaymentLinkStatus.PAID) return;

    await this.markPaidAndApply(link, payload.razorpayPaymentId, payload.rawPayload);
  }

  private async markPaidAndApply(
    link: GatewayPaymentLink,
    razorpayPaymentId: string,
    rawPayload: object,
  ): Promise<GatewayPaymentLink> {
    let applicationError: string | undefined;
    try {
      await this.applyPayment(link, razorpayPaymentId);
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
      rawWebhookPayload: rawPayload,
      applicationError,
    });
    return this.gatewayPaymentLinkRepo.findById(link.id);
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
      case GatewayPaymentReferenceType.NEW_ORDER_PAYMENT: {
        // Nothing to apply — referenceId is only a client-generated
        // correlation id, not a real order (Create Order doesn't create the
        // order until payment is confirmed). The admin panel creates it
        // itself right after this resolves, passing razorpayPaymentId
        // through as the order's own trusted payment reference.
        return;
      }
      default:
        throw new Error(`Unknown gateway payment reference type: ${link.referenceType}`);
    }
  }
}
