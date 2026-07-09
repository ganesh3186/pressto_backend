import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PaymentMode, PaymentRequestStatus, ReferenceType, WalletTransactionType} from '../models';
import {WalletRechargeRequest} from '../models/wallet-recharge-request.model';
import {WalletRechargeRequestRepository, WalletRepository, WalletTransactionRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class WalletService {
  constructor(
    @repository(WalletRepository) private walletRepository: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepository: WalletTransactionRepository,
    @repository(WalletRechargeRequestRepository) private rechargeRequestRepository: WalletRechargeRequestRepository,
  ) {}

  async createWallet(customerId: string, options?: object): Promise<any> {
    return this.walletRepository.create({customerId, currentBalance: 0}, options);
  }

  async credit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const wallet = await this.walletRepository.findById(walletId, undefined, options);
    const newBalance = Number(wallet.currentBalance) + Number(amount);
    await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options);
    return this.walletTransactionRepository.create({
      walletId,
      transactionType: WalletTransactionType.CREDIT,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
  }

  async debit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const wallet = await this.walletRepository.findById(walletId, undefined, options);
    if (Number(wallet.currentBalance) < Number(amount)) {
      throw new HttpErrors.BadRequest('Insufficient wallet balance.');
    }
    const newBalance = Number(wallet.currentBalance) - Number(amount);
    await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options);
    return this.walletTransactionRepository.create({
      walletId,
      transactionType: WalletTransactionType.DEBIT,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
  }

  // ─── Recharge flow ────────────────────────────────────────────────────────

  async initiateRecharge(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    remarks?: string,
  ): Promise<WalletRechargeRequest> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Recharge amount must be greater than zero.');
    }

    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      throw new HttpErrors.NotFound('Wallet not found for this customer.');
    }

    const count = await this.rechargeRequestRepository.count({customerId});
    const requestNumber = `WR${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    return this.rechargeRequestRepository.create({
      id: v4(),
      customerId,
      walletId: wallet.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.PENDING,
      remarks,
    });
  }

  async confirmRecharge(
    rechargeRequestId: string,
    customerId: string,
    paymentReferenceId?: string,
    gatewayResponse?: string,
  ): Promise<{rechargeRequest: WalletRechargeRequest; walletBalance: number}> {
    const request = await this.rechargeRequestRepository.findById(rechargeRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Recharge request is already ${request.status}.`);
    }

    await this.rechargeRequestRepository.updateById(rechargeRequestId, {
      status: PaymentRequestStatus.SUCCESS,
      paymentReferenceId,
      gatewayResponse,
    });

    await this.credit(
      request.walletId,
      request.amount,
      ReferenceType.MANUAL,
      rechargeRequestId,
      `Wallet recharge - ${request.requestNumber}`,
    );

    const wallet = await this.walletRepository.findById(request.walletId);
    const updatedRequest = await this.rechargeRequestRepository.findById(rechargeRequestId);

    return {rechargeRequest: updatedRequest, walletBalance: wallet.currentBalance!};
  }

  async cancelRecharge(rechargeRequestId: string, customerId: string): Promise<void> {
    const request = await this.rechargeRequestRepository.findById(rechargeRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Cannot cancel a recharge request that is already ${request.status}.`);
    }

    await this.rechargeRequestRepository.updateById(rechargeRequestId, {
      status: PaymentRequestStatus.CANCELLED,
    });
  }

  async getRechargeHistory(customerId: string, limit = 20, skip = 0): Promise<WalletRechargeRequest[]> {
    return this.rechargeRequestRepository.find({
      where: {customerId},
      order: ['createdAt DESC'],
      limit,
      skip,
    });
  }

  // Returns the full transaction ledger (credits + debits) with current balance.
  // This is the source of truth for what to show in the wallet tab.
  async getWalletHistory(customerId: string, limit = 50, skip = 0): Promise<{balance: number; transactions: object[]}> {
    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      return {balance: 0, transactions: []};
    }

    const transactions = await this.walletTransactionRepository.find({
      where: {walletId: wallet.id, isDeleted: false} as any,
      order: ['transactionDate DESC'],
      limit,
      skip,
    });

    return {
      balance: Number(wallet.currentBalance ?? 0),
      transactions,
    };
  }

  // Admin directly credits — no pending phase since payment is already collected in-store
  async adminRecharge(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    performedBy: string,
    remarks?: string,
  ): Promise<{rechargeRequest: WalletRechargeRequest; walletBalance: number}> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Recharge amount must be greater than zero.');
    }

    const wallet = await this.walletRepository.findOne({where: {customerId}});
    if (!wallet) {
      throw new HttpErrors.NotFound('Wallet not found for this customer.');
    }

    const count = await this.rechargeRequestRepository.count({customerId});
    const requestNumber = `WR${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    const rechargeRequest = await this.rechargeRequestRepository.create({
      id: v4(),
      customerId,
      walletId: wallet.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.SUCCESS,
      performedBy,
      remarks,
    });

    await this.credit(
      wallet.id,
      amount,
      ReferenceType.MANUAL,
      rechargeRequest.id,
      `Admin wallet recharge - ${requestNumber}`,
    );

    const updatedWallet = await this.walletRepository.findById(wallet.id);
    return {rechargeRequest, walletBalance: updatedWallet.currentBalance!};
  }
}
