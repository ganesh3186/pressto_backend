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
  @authorize({roles: ['super_admin'], permissions: ['customer_recharge:create']})
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

  // ─── Admin Wallet Recharge — PGLink (deferred, not immediate) ───────────────
  // Unlike adminWalletRecharge above (credits synchronously, status SUCCESS
  // from the moment it's called), a PGLink recharge can't credit until the
  // customer actually pays — so this creates a PENDING request via the same
  // initiateRecharge() the customer self-service flow already uses, and
  // returns its id for the caller to hand to
  // POST /payments/gateway-links (referenceType: wallet_topup). Only
  // RazorpayService's webhook handler ever calls confirmRecharge() on it.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gateway_payment:create']})
  @post('/admin/customers/{customerId}/wallet/recharge/initiate-gateway')
  @response(200, {description: 'Pending wallet recharge request created, for a PGLink to attach to'})
  async adminWalletRechargeInitiateGateway(
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount'],
            properties: {amount: {type: 'number', minimum: 1}, remarks: {type: 'string'}},
          },
        },
      },
    })
    body: {amount: number; remarks?: string},
  ): Promise<object> {
    const rechargeRequest = await this.walletService.initiateRecharge(
      customerId,
      body.amount,
      PaymentMode.GATEWAY,
      body.remarks,
    );
    return {rechargeRequest};
  }

  // ─── Admin Wallet Debit (correction) ─────────────────────────────────────
  // Counterpart to adminWalletRecharge — for reversing a wallet credit that
  // was applied by mistake. Distinct permission (customer_recharge:debit)
  // so it can be granted independently of ordinary recharge ability.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_recharge:debit']})
  @post('/admin/customers/{customerId}/wallet/debit')
  @response(200, {description: 'Wallet debited by admin'})
  async adminWalletDebit(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount', 'remarks'],
            properties: {
              amount: {type: 'number', minimum: 1},
              remarks: {
                type: 'string',
                description: 'Required — the reason this wallet is being debited.',
              },
            },
          },
        },
      },
    })
    body: {amount: number; remarks: string},
  ): Promise<object> {
    // A human-readable label for the remarks trail (see WalletService.adminDebit) —
    // WalletTransaction has no performedBy column of its own, so raw
    // currentUser[securityId] (a uuid) must never land there directly.
    const userLabel = currentUser as {name?: string; email?: string};
    const performedByLabel = userLabel.name ?? userLabel.email ?? currentUser[securityId];
    const result = await this.walletService.adminDebit(customerId, body.amount, performedByLabel, body.remarks);
    return {
      message: 'Wallet debited successfully.',
      walletBalance: result.walletBalance,
    };
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_recharge:read']})
  @get('/admin/customers/{customerId}/wallet/recharge-history')
  @response(200, {description: 'Customer wallet recharge history'})
  async adminWalletRechargeHistory(
    @param.path.string('customerId') customerId: string,
    @param.query.number('limit') limit = 50,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    return this.walletService.getWalletHistory(customerId, limit, skip);
  }

  // ─── Admin Security Deposit Top-up ───────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_recharge:create']})
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

  // Same reasoning as adminWalletRechargeInitiateGateway above — creates a
  // PENDING request via the existing initiateTopup(), never credits here.
  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['gateway_payment:create']})
  @post('/admin/customers/{customerId}/security-deposit/topup/initiate-gateway')
  @response(200, {description: 'Pending security deposit top-up request created, for a PGLink to attach to'})
  async adminSecurityDepositTopupInitiateGateway(
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount'],
            properties: {amount: {type: 'number', minimum: 1}, remarks: {type: 'string'}},
          },
        },
      },
    })
    body: {amount: number; remarks?: string},
  ): Promise<object> {
    const topupRequest = await this.securityDepositService.initiateTopup(
      customerId,
      body.amount,
      PaymentMode.GATEWAY,
      body.remarks,
    );
    return {topupRequest};
  }

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['customer_recharge:read']})
  @get('/admin/customers/{customerId}/security-deposit/topup-history')
  @response(200, {description: 'Customer security deposit top-up history'})
  async adminSecurityDepositTopupHistory(
    @param.path.string('customerId') customerId: string,
    @param.query.number('limit') limit = 50,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    return this.securityDepositService.getDepositHistory(customerId, limit, skip);
  }
}
