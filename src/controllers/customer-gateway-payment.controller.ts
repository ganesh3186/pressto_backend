import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {GatewayPaymentLink} from '../models/gateway-payment-link.model';
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {
  CustomerRepository,
  GatewayPaymentLinkRepository,
  OrderRepository,
  WalletRechargeRequestRepository,
} from '../repositories';
import {RazorpayService} from '../services/razorpay.service';

/**
 * Customer-facing counterpart to GatewayPaymentController — same
 * RazorpayService underneath, but scoped to the calling customer's own
 * order / wallet-recharge request instead of the staff `super_admin` gate.
 * Only ORDER_PAYMENT and WALLET_TOPUP are reachable here (the two flows a
 * customer can self-initiate today, via CustomerOrderController and
 * CustomerRechargeController's initiate-gateway endpoints) —
 * SECURITY_DEPOSIT_TOPUP and NEW_ORDER_PAYMENT stay staff/POS-only.
 */
export class CustomerGatewayPaymentController {
  constructor(
    @repository(GatewayPaymentLinkRepository)
    private gatewayPaymentLinkRepository: GatewayPaymentLinkRepository,
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(OrderRepository)
    private orderRepository: OrderRepository,
    @repository(WalletRechargeRequestRepository)
    private walletRechargeRequestRepository: WalletRechargeRequestRepository,
    @inject('services.razorpay')
    private razorpayService: RazorpayService,
  ) {}

  private async resolveCustomerId(userId: string): Promise<string> {
    const customer = await this.customerRepository.findOne({
      where: {userId, isDeleted: false},
    });
    if (!customer) {
      throw new HttpErrors.NotFound('Customer profile not found.');
    }
    return customer.id;
  }

  /** Hard-fail unless this link belongs to the calling customer. */
  private async assertOwnership(link: GatewayPaymentLink, customerId: string): Promise<void> {
    switch (link.referenceType) {
      case GatewayPaymentReferenceType.ORDER_PAYMENT: {
        const order = await this.orderRepository.findOne({
          where: {id: link.referenceId, isDeleted: false} as object,
        });
        if (!order || order.customerId !== customerId) {
          throw new HttpErrors.Forbidden('You do not have access to this payment.');
        }
        return;
      }
      case GatewayPaymentReferenceType.WALLET_TOPUP: {
        const request = await this.walletRechargeRequestRepository.findById(link.referenceId);
        if (!request || request.customerId !== customerId) {
          throw new HttpErrors.Forbidden('You do not have access to this payment.');
        }
        return;
      }
      default:
        // SECURITY_DEPOSIT_TOPUP / NEW_ORDER_PAYMENT: not a customer-self-
        // service surface (yet) — never let a customer touch these here.
        throw new HttpErrors.Forbidden('You do not have access to this payment.');
    }
  }

  // ─── Verify (Checkout popup's `handler` callback) ──────────────────────────
  // Called by the frontend the instant Razorpay's own popup reports
  // success — the primary confirmation path. The actual trust boundary is
  // the per-payment signature checked inside verifyAndApplyPayment(), not
  // this endpoint's ownership check — that check only prevents a customer
  // from probing/verifying a link that isn't theirs.
  @authenticate('jwt')
  @post('/profile/customer/payments/gateway-links/{id}/verify')
  @response(200, {description: 'Gateway payment verified and applied'})
  async verify(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'],
            properties: {
              razorpayOrderId: {type: 'string'},
              razorpayPaymentId: {type: 'string'},
              razorpaySignature: {type: 'string'},
            },
          },
        },
      },
    })
    body: {razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string},
  ): Promise<GatewayPaymentLink> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const link = await this.gatewayPaymentLinkRepository.findById(id);
    await this.assertOwnership(link, customerId);
    return this.razorpayService.verifyAndApplyPayment({id, ...body});
  }

  // ─── Status check ───────────────────────────────────────────────────────────
  // Polling fallback for when the browser reloads mid-payment (e.g. a UPI
  // intent app-switch) and the Checkout `handler` never gets to fire.
  @authenticate('jwt')
  @get('/profile/customer/payments/gateway-links/{id}')
  @response(200, {description: 'Gateway payment link status'})
  async findById(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<GatewayPaymentLink> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const link = await this.gatewayPaymentLinkRepository.findById(id);
    await this.assertOwnership(link, customerId);
    return link;
  }
}
