import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {get, HttpErrors, param, post, Request, requestBody, response, RestBindings} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
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

// Reads the exact bytes Razorpay signed. LoopBack's body parsers would
// decode the JSON first, and the signature has to be checked over the
// original text, so this route deliberately bypasses them.
function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', chunk => (data += chunk));
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
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
  // is enough here. Nothing is actually credited until a signature-
  // verified confirmation (verify() or the webhook) fires — creating a
  // spurious order isn't a money risk. `razorpayKeyId` rides along on the
  // response so the frontend has what it needs to open the inline
  // Checkout popup without a separate config round-trip — it's Razorpay's
  // publishable key, not the secret.
  @authenticate('jwt')
  @post('/payments/gateway-links')
  @response(200, {description: 'Gateway payment order created'})
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
  ): Promise<object> {
    const link = await this.razorpayService.createOrder({
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
    return {...(link.toJSON() as object), razorpayKeyId: process.env.RAZORPAY_KEY_ID};
  }

  // ─── Create (shareable Payment Link) ────────────────────────────────────────
  // Order payment only (Tax Invoice / Create Order) — the one PGLink
  // surface that sends staff a link to share over WhatsApp instead of
  // opening Razorpay's Checkout themselves. Same auth rationale as
  // create() above; no razorpayKeyId in the response since nothing opens
  // Checkout here, just shortUrl to hand to WhatsAppService.
  @authenticate('jwt')
  @post('/payments/gateway-links/shareable')
  @response(200, {description: 'Shareable Razorpay payment link created'})
  async createShareable(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['referenceId', 'amount', 'customerName'],
            properties: {
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
    body: Omit<CreateGatewayLinkBody, 'referenceType'>,
  ): Promise<object> {
    const link = await this.razorpayService.createPaymentLink({
      referenceType: GatewayPaymentReferenceType.ORDER_PAYMENT,
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
    return link.toJSON() as object;
  }

  // ─── Verify (Checkout popup's `handler` callback) ──────────────────────────
  // Called by the frontend the instant Razorpay's own popup reports
  // success — the primary confirmation path. Same auth as create(); the
  // actual trust boundary is the per-payment signature checked inside
  // verifyAndApplyPayment(), not this endpoint's authorization.
  @authenticate('jwt')
  @post('/payments/gateway-links/{id}/verify')
  @response(200, {description: 'Gateway payment verified and applied'})
  async verify(
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
    return this.razorpayService.verifyAndApplyPayment({id, ...body});
  }

  // ─── Status check ───────────────────────────────────────────────────────────
  @authenticate('jwt')
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
  // the JSON and silently break the signature check). Fallback path only
  // — the frontend's own verify() call after the Checkout popup succeeds
  // is what normally applies the payment; this catches the case where
  // that never happens (closed tab, a UPI intent that completes later).
  @post('/webhooks/razorpay')
  @response(200, {description: 'Webhook acknowledged'})
  async webhook(
    @inject(RestBindings.Http.REQUEST) request: Request,
  ): Promise<{received: boolean}> {
    const rawBody = await readRawBody(request);
    const signature = request.headers['x-razorpay-signature'] as string | undefined;
    if (!this.razorpayService.verifyWebhookSignature(rawBody, signature)) {
      throw new HttpErrors.BadRequest('Invalid webhook signature.');
    }

    const payload = JSON.parse(rawBody);
    if (payload?.event === 'payment.captured') {
      const paymentEntity = payload?.payload?.payment?.entity;
      if (paymentEntity?.order_id && paymentEntity?.id) {
        await this.razorpayService.handlePaymentCaptured({
          razorpayOrderId: paymentEntity.order_id,
          razorpayPaymentId: paymentEntity.id,
          rawPayload: payload,
        });
      }
    } else if (payload?.event === 'payment_link.paid') {
      // Payment Link webhooks nest both entities under their own keys —
      // the link itself (payload.payment_link.entity) and the payment
      // that paid it (payload.payment.entity), siblings of each other,
      // not nested the way payment.captured nests payment under payload.
      const linkEntity = payload?.payload?.payment_link?.entity;
      const paymentEntity = payload?.payload?.payment?.entity;
      if (linkEntity?.id && paymentEntity?.id) {
        await this.razorpayService.handlePaymentLinkPaid({
          razorpayPaymentLinkId: linkEntity.id,
          razorpayPaymentId: paymentEntity.id,
          rawPayload: payload,
        });
      }
    }

    // Always 200 once the signature checks out — Razorpay retries on
    // anything else, and a genuine application failure is already
    // recorded on the link itself (see handlePaymentCaptured) rather than
    // something a retry would fix.
    return {received: true};
  }
}
