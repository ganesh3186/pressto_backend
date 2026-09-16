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
import {GatewayPaymentReferenceType} from '../models/gateway-payment-reference-type.enum';
import {PaymentMode} from '../models/payment-mode.enum';
import {CustomerRepository, UsersRepository} from '../repositories';
import {RazorpayService} from '../services/razorpay.service';
import {SecurityDepositService} from '../services/security-deposit.service';
import {WalletService} from '../services/wallet.service';

export class CustomerRechargeController {
  constructor(
    @repository(CustomerRepository)
    private customerRepository: CustomerRepository,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @inject('services.wallet')
    private walletService: WalletService,
    @inject('services.security-deposit')
    private securityDepositService: SecurityDepositService,
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

  // Name/email/phone Razorpay's Checkout popup prefills with — pulled from
  // the customer's own profile so they never have to re-type it themselves.
  private async resolveCustomerContact(
    customerId: string,
  ): Promise<{name: string; email?: string; contact?: string}> {
    const customer = await this.customerRepository.findById(customerId);
    const user = await this.usersRepository.findById(customer.userId);
    const trimmedFullName = user.fullName?.trim();
    const combinedName = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();
    const name = trimmedFullName ? trimmedFullName : combinedName ? combinedName : 'Customer';
    return {name, email: customer.email ?? user.email, contact: user.phone};
  }

  // ─── Wallet Recharge ─────────────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/customer/wallet/recharge/initiate')
  @response(200, {description: 'Wallet recharge request created'})
  async initiateWalletRecharge(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const rechargeRequest = await this.walletService.initiateRecharge(
      customerId,
      body.amount,
      body.paymentMode,
      body.remarks,
    );
    return {
      message: 'Recharge request created. Proceed with payment.',
      rechargeRequest,
    };
  }

  // Customer-initiated equivalent of the admin's
  // adminWalletRechargeInitiateGateway + gateway-payment.controller.ts's
  // create(), collapsed into one call — unlike the POS counter flow there's
  // no staff-side gap between "customer picks an amount" and "open
  // Checkout". Creates the PENDING WalletRechargeRequest via the same
  // initiateRecharge() every other wallet mode already uses, then a real
  // Razorpay order via RazorpayService. Nothing is credited here — only a
  // signature-verified confirmWalletRechargeGateway() call (or the webhook)
  // actually applies it, via RazorpayService.applyPayment()'s existing
  // WALLET_TOPUP case (WalletService.confirmRecharge), the same path the
  // admin flow already uses.
  @authenticate('jwt')
  @post('/profile/customer/wallet/recharge/initiate-gateway')
  @response(200, {description: 'Wallet recharge Razorpay order created'})
  async initiateWalletRechargeGateway(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount'],
            properties: {
              amount: {type: 'number', minimum: 1},
              remarks: {type: 'string'},
            },
          },
        },
      },
    })
    body: {amount: number; remarks?: string},
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const contact = await this.resolveCustomerContact(customerId);

    const rechargeRequest = await this.walletService.initiateRecharge(
      customerId,
      body.amount,
      PaymentMode.GATEWAY,
      body.remarks,
    );

    const gatewayLink = await this.razorpayService.createOrder({
      referenceType: GatewayPaymentReferenceType.WALLET_TOPUP,
      referenceId: rechargeRequest.id,
      amount: body.amount,
      description: `Wallet recharge - ${rechargeRequest.requestNumber}`,
      customer: contact,
      createdBy: currentUser[securityId],
    });

    return {
      message: 'Proceed with payment.',
      rechargeRequest,
      gatewayLink: {...(gatewayLink.toJSON() as object), razorpayKeyId: process.env.RAZORPAY_KEY_ID},
    };
  }

  @authenticate('jwt')
  @post('/profile/customer/wallet/recharge/confirm')
  @response(200, {description: 'Wallet recharged successfully'})
  async confirmWalletRecharge(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['rechargeRequestId'],
            properties: {
              rechargeRequestId: {type: 'string'},
              paymentReferenceId: {type: 'string'},
              gatewayResponse: {type: 'string'},
            },
          },
        },
      },
    })
    body: {rechargeRequestId: string; paymentReferenceId?: string; gatewayResponse?: string},
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const result = await this.walletService.confirmRecharge(
      body.rechargeRequestId,
      customerId,
      body.paymentReferenceId,
      body.gatewayResponse,
    );
    return {
      message: 'Wallet recharged successfully.',
      rechargeRequest: result.rechargeRequest,
      walletBalance: result.walletBalance,
    };
  }

  @authenticate('jwt')
  @post('/profile/customer/wallet/recharge/cancel')
  @response(200, {description: 'Recharge request cancelled'})
  async cancelWalletRecharge(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['rechargeRequestId'],
            properties: {
              rechargeRequestId: {type: 'string'},
            },
          },
        },
      },
    })
    body: {rechargeRequestId: string},
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    await this.walletService.cancelRecharge(body.rechargeRequestId, customerId);
    return {message: 'Recharge request cancelled.'};
  }

  @authenticate('jwt')
  @get('/profile/customer/wallet/recharge-history')
  @response(200, {description: 'Wallet recharge history'})
  async walletRechargeHistory(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.number('limit') limit = 20,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const history = await this.walletService.getRechargeHistory(customerId, limit, skip);
    return {history};
  }

  // ─── Security Deposit Top-up ─────────────────────────────────────────────

  @authenticate('jwt')
  @post('/profile/customer/security-deposit/topup/initiate')
  @response(200, {description: 'Security deposit top-up request created'})
  async initiateSecurityDepositTopup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
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
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const topupRequest = await this.securityDepositService.initiateTopup(
      customerId,
      body.amount,
      body.paymentMode,
      body.remarks,
    );
    return {
      message: 'Top-up request created. Proceed with payment.',
      topupRequest,
    };
  }

  @authenticate('jwt')
  @post('/profile/customer/security-deposit/topup/confirm')
  @response(200, {description: 'Security deposit topped up successfully'})
  async confirmSecurityDepositTopup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['topupRequestId'],
            properties: {
              topupRequestId: {type: 'string'},
              paymentReferenceId: {type: 'string'},
              gatewayResponse: {type: 'string'},
            },
          },
        },
      },
    })
    body: {topupRequestId: string; paymentReferenceId?: string; gatewayResponse?: string},
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const result = await this.securityDepositService.confirmTopup(
      body.topupRequestId,
      customerId,
      body.paymentReferenceId,
      body.gatewayResponse,
    );
    return {
      message: 'Security deposit topped up successfully.',
      topupRequest: result.topupRequest,
      availableBalance: result.availableBalance,
    };
  }

  @authenticate('jwt')
  @post('/profile/customer/security-deposit/topup/cancel')
  @response(200, {description: 'Top-up request cancelled'})
  async cancelSecurityDepositTopup(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['topupRequestId'],
            properties: {
              topupRequestId: {type: 'string'},
            },
          },
        },
      },
    })
    body: {topupRequestId: string},
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    await this.securityDepositService.cancelTopup(body.topupRequestId, customerId);
    return {message: 'Top-up request cancelled.'};
  }

  @authenticate('jwt')
  @get('/profile/customer/security-deposit/topup-history')
  @response(200, {description: 'Security deposit top-up history'})
  async securityDepositTopupHistory(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.query.number('limit') limit = 20,
    @param.query.number('skip') skip = 0,
  ): Promise<object> {
    const customerId = await this.resolveCustomerId(currentUser[securityId]);
    const history = await this.securityDepositService.getTopupHistory(customerId, limit, skip);
    return {history};
  }
}
