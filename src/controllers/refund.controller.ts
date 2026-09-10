import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {
  get,
  HttpErrors,
  param,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {RefundBankDetails} from '../models/refund-due.model';
import {RefundMethod} from '../models/refund-method.enum';
import {RefundDueRepository} from '../repositories';
import {ApprovalService} from '../services/approval.service';
import {StoreScopeService} from '../services/store-scope.service';

/**
 * The deferred refund-payout pipeline's read/select-method surface. Creation
 * of a RefundDue happens from inside the flow that discovers the money is
 * owed (Sales Return approval, Return Item approval, Upgrade/Downgrade
 * overpayment) — see ApprovalService.createRefundDue — never here.
 */
export class RefundController {
  constructor(
    @repository(RefundDueRepository) private refundDueRepo: RefundDueRepository,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @inject('services.approval') private approvalService: ApprovalService,
  ) {}

  // ─── List refunds due for an order ────────────────────────────────────────
  // Every status, not just pending — the invoice dialogue needs to show
  // "requested, awaiting approval" and "paid" too, not just what still needs
  // a method picked.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:read']})
  @get('/orders/{orderId}/refunds-due')
  @response(200, {description: 'All refunds due (any status) for an order'})
  async listForOrder(
    @param.path.string('orderId') orderId: string,
    @inject(AuthenticationBindings.CURRENT_USER) currentUser?: UserProfile,
  ): Promise<object> {
    await this.storeScopeService.assertOrderVisible(orderId, currentUser!);

    const refundsDue = await this.refundDueRepo.find({
      where: {orderId},
      order: ['createdAt DESC'],
    });

    return {refundsDue};
  }

  // ─── Pick a payout method ──────────────────────────────────────────────────
  // Does NOT move any money — it raises a REFUND_PAYOUT approval for finance
  // to grant. The payout itself only happens once that's approved (see
  // ApprovalService._applyRefundPayout).

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['order:update']})
  @post('/refunds-due/{id}/select-method')
  @response(200, {
    description: 'Payout method selected — refund payout approval raised',
  })
  async selectMethod(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['method'],
            properties: {
              method: {type: 'string', enum: Object.values(RefundMethod)},
              bankDetails: {
                type: 'object',
                properties: {
                  accountHolderName: {type: 'string'},
                  bankName: {type: 'string'},
                  accountNumber: {type: 'string'},
                  ifscCode: {type: 'string'},
                  branchName: {type: 'string'},
                },
              },
            },
          },
        },
      },
    })
    body: {method: RefundMethod; bankDetails?: RefundBankDetails},
  ): Promise<object> {
    if (!body?.method) throw new HttpErrors.BadRequest('method is required.');

    const refundDue = await this.approvalService.selectPayoutMethod({
      refundDueId: id,
      method: body.method,
      bankDetails: body.bankDetails,
      requestedBy: currentUser[securityId],
    });

    return {refundDue};
  }
}
