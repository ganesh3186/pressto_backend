import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, Request, requestBody, response, RestBindings} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {GatewayPaymentLink} from '../models/gateway-payment-link.model';
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {GatewayPaymentLinkRepository} from '../repositories';
import {RazorpayService} from '../services/razorpay.service';

interface CreateGatewayLinkBody {
  referenceType: GatewayPaymentReferenceType;
  referenceId: string;
  amount: number;
  description?: string;
  customerName: string;
  customerEmail?: string;
  customerContact?: string;
}

export class GatewayPaymentController {
  constructor(
    @repository(GatewayPaymentLinkRepository)
    private gatewayPaymentLinkRepository: GatewayPaymentLinkRepository,
    @inject('services.razorpay')
    private razorpayService: RazorpayService,
  ) {}

  // ─── Create ───────────────────────────────────────────────────────────────
  // Admin-panel-only surface (POS, wallet/security-deposit top-up) — every
  // caller is already an authenticated staff member acting on behalf of a
  // customer, not the customer themselves, so a single authenticated gate
  // is enough here. Nothing is actually credited until the signature-
  // verified webhook fires — creating a spurious link isn't a money risk.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gateway_payment:create']})
  @post('/payments/gateway-links')
  @response(200, {description: 'Gateway payment link created'})
  async create(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['referenceType', 'referenceId', 'amount', 'customerName'],
            properties: {
              referenceType: {type: 'string', enum: Object.values(GatewayPaymentReferenceType)},
              referenceId: {type: 'string', format: 'uuid'},
              amount: {type: 'number'},
              description: {type: 'string'},
              customerName: {type: 'string'},
              customerEmail: {type: 'string'},
              customerContact: {type: 'string'},
            },
          },
        },
      },
    })
    body: CreateGatewayLinkBody,
  ): Promise<GatewayPaymentLink> {
    return this.razorpayService.createPaymentLink({
      referenceType: body.referenceType,
      referenceId: body.referenceId,
      amount: body.amount,
      description: body.description ?? 'Pressto payment',
      customer: {
        name: body.customerName,
        email: body.customerEmail,
        contact: body.customerContact,
      },
      createdBy: currentUser[securityId],
    });
  }

  // ─── Status check (frontend polling) ───────────────────────────────────────
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gateway_payment:read']})
  @get('/payments/gateway-links/{id}')
  @response(200, {description: 'Gateway payment link status'})
  async findById(@param.path.string('id') id: string): Promise<GatewayPaymentLink> {
    const link = await this.gatewayPaymentLinkRepository.findById(id);
    if (!link) throw new HttpErrors.NotFound('Gateway payment link not found.');
    return link;
  }

  // ─── Webhook (Razorpay → us) ────────────────────────────────────────────────
  // No @authenticate — Razorpay's servers call this directly, there's no
  // user session to carry. Guarded instead by verifyWebhookSignature,
  // computed over the RAW body (x-parser: 'text' below deliberately skips
  // LB4's usual JSON parsing so the exact bytes Razorpay signed are what
  // gets hashed — parsing first and re-stringifying can reorder/reformat
  // the JSON and silently break the signature check).
  @post('/webhooks/razorpay')
  @response(200, {description: 'Webhook acknowledged'})
  async webhook(
    @inject(RestBindings.Http.REQUEST) request: Request,
    @requestBody({content: {'application/json': {'x-parser': 'text', schema: {type: 'string'}}}})
    rawBody: string,
  ): Promise<{received: boolean}> {
    const signature = request.headers['x-razorpay-signature'] as string | undefined;
    if (!this.razorpayService.verifyWebhookSignature(rawBody, signature)) {
      throw new HttpErrors.BadRequest('Invalid webhook signature.');
    }

    const payload = JSON.parse(rawBody);
    if (payload?.event === 'payment_link.paid') {
      const entity = payload?.payload?.payment_link?.entity;
      const paymentEntity = payload?.payload?.payment?.entity;
      if (entity?.id && paymentEntity?.id) {
        await this.razorpayService.handlePaymentLinkPaid({
          razorpayLinkId: entity.id,
          razorpayPaymentId: paymentEntity.id,
          rawPayload: payload,
        });
      }
    }

    // Always 200 once the signature checks out — Razorpay retries on
    // anything else, and a genuine application failure is already
    // recorded on the link itself (see handlePaymentLinkPaid) rather than
    // something a retry would fix.
    return {received: true};
  }
}
