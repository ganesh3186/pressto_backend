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
import {PaymentMode} from '../models/payment-mode.enum';
import {ShiftStatus} from '../models/shift-status.enum';
import {ShiftRepository} from '../repositories';
import {SecurityDepositService} from '../services/security-deposit.service';
import {StoreScopeService} from '../services/store-scope.service';
import {WalletService} from '../services/wallet.service';

export class AdminCustomerRechargeController {
  constructor(
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
    @repository(ShiftRepository)
    private shiftRepository: ShiftRepository,
  ) {}

  /**
   * Shared gate for every staff-initiated (admin-panel) wallet recharge —
   * resolves which store this recharge is for, then requires an OPEN shift
   * there before any money moves. Applies to every role, no exceptions
   * (including super_admin): "shift closed" means nobody recharges at that
   * store, not just counter roles (unlike the generic ShiftGuard on the
   * frontend, which only locks out ccc/cce/cci/store_exec).
   *
   * Never applied to the customer's own self-service app top-up
   * (CustomerRechargeController) — that has no store/shift concept.
   */
  private async requireOpenShiftForRecharge(
    currentUser: UserProfile,
    requestedStoreId?: string,
  ): Promise<{storeId: string; shiftId: string}> {
    const storeId = await this.storeScopeService.resolveCallerStoreId(
      currentUser[securityId],
      requestedStoreId,
    );
    const shift = await this.shiftRepository.findOne({
      where: {storeId, status: ShiftStatus.OPEN} as object,
    });
    if (!shift) {
      throw new HttpErrors.BadRequest(
        'Open a shift at this store before recharging a wallet.',
      );
    }
    return {storeId, shiftId: shift.id};
  }

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
              storeId: {
                type: 'string',
                description: 'Required only if the caller is bound to more than one store.',
              },
            },
          },
        },
      },
    })
    body: {amount: number; paymentMode: PaymentMode; remarks?: string; storeId?: string},
  ): Promise<object> {
    const performedBy = currentUser[securityId];
    const {storeId, shiftId} = await this.requireOpenShiftForRecharge(currentUser, body.storeId);
    const result = await this.walletService.adminRecharge(
      customerId,
      body.amount,
      body.paymentMode,
      performedBy,
      body.remarks,
      storeId,
      shiftId,
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
  @post('/admin/customers/{customerId}/wallet/recharge/initiate-gateway')
  @response(200, {description: 'Pending wallet recharge request created, for a PGLink to attach to'})
  async adminWalletRechargeInitiateGateway(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('customerId') customerId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount'],
            properties: {
              amount: {type: 'number', minimum: 1},
              remarks: {type: 'string'},
              storeId: {
                type: 'string',
                description: 'Required only if the caller is bound to more than one store.',
              },
            },
          },
        },
      },
    })
    body: {amount: number; remarks?: string; storeId?: string},
  ): Promise<object> {
    const {storeId, shiftId} = await this.requireOpenShiftForRecharge(currentUser, body.storeId);
    const rechargeRequest = await this.walletService.initiateRecharge(
      customerId,
      body.amount,
      PaymentMode.GATEWAY,
      body.remarks,
      storeId,
      shiftId,
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

  // ─── Wallet Transactions (Wallet > Transactions admin page) ──────────────
  // Deliberately unscoped — every caller with wallet_transactions:read sees
  // every transaction system-wide, same posture as the Customer list. No
  // store/cluster/region filtering by design (see conversation history).
  @authenticate('jwt')
  @authorize({permissions: ['wallet_transactions:read']})
  @get('/admin/wallet/transactions')
  @response(200, {description: 'Wallet transactions ledger (recharges + order redemptions)'})
  async walletTransactions(
    @param.query.string('customerName') customerName?: string,
    @param.query.string('mobile') mobile?: string,
    @param.query.string('status') status?: 'credit' | 'debit',
    @param.query.number('limit') limit = 50,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    return this.walletService.getAllTransactions({customerName, mobile, status, limit, skip});
  }
}
