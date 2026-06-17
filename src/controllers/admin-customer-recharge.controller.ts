import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {
  get,
  param,
  post,
  requestBody,
  response,
} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {PaymentMode} from '../models/payment-mode.enum';
import {SecurityDepositService} from '../services/security-deposit.service';
import {WalletService} from '../services/wallet.service';

export class AdminCustomerRechargeController {
  constructor(
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
  ) {}

  // ─── Admin Wallet Recharge ────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/admin/customers/{customerId}/wallet/recharge')
  @response(200, {description: 'Wallet recharged by admin'})
  async adminWalletRecharge(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount', 'paymentMode'],
            properties: {
              amount: {type: 'number', minimum: 1},
              paymentMode: {type: 'string', enum: Object.values(PaymentMode)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {amount: number; paymentMode: PaymentMode; remarks?: string},
  ): Promise<object> {
    const performedBy = currentUser[securityId];
    const result = await this.walletService.adminRecharge(
      customerId,
      body.amount,
      body.paymentMode,
      performedBy,
      body.remarks,
    );
    return {
      message: 'Wallet recharged successfully.',
      rechargeRequest: result.rechargeRequest,
      walletBalance: result.walletBalance,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/admin/customers/{customerId}/wallet/recharge-history')
  @response(200, {description: 'Customer wallet recharge history'})
  async adminWalletRechargeHistory(
    @param.path.string('customerId') customerId: string,
    @param.query.number('limit') limit = 20,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    const history = await this.walletService.getRechargeHistory(customerId, limit, skip);
    return {history};
  }

  // ─── Admin Security Deposit Top-up ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @post('/admin/customers/{customerId}/security-deposit/topup')
  @response(200, {description: 'Security deposit topped up by admin'})
  async adminSecurityDepositTopup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount', 'paymentMode'],
            properties: {
              amount: {type: 'number', minimum: 1},
              paymentMode: {type: 'string', enum: Object.values(PaymentMode)},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {amount: number; paymentMode: PaymentMode; remarks?: string},
  ): Promise<object> {
    const performedBy = currentUser[securityId];
    const result = await this.securityDepositService.adminTopup(
      customerId,
      body.amount,
      body.paymentMode,
      performedBy,
      body.remarks,
    );
    return {
      message: 'Security deposit topped up successfully.',
      topupRequest: result.topupRequest,
      availableBalance: result.availableBalance,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin']})
  @get('/admin/customers/{customerId}/security-deposit/topup-history')
  @response(200, {description: 'Customer security deposit top-up history'})
  async adminSecurityDepositTopupHistory(
    @param.path.string('customerId') customerId: string,
    @param.query.number('limit') limit = 20,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    const history = await this.securityDepositService.getTopupHistory(customerId, limit, skip);
    return {history};
  }
}
