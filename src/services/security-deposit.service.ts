import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {PaymentMode, PaymentRequestStatus, ReferenceType, SecurityDepositStatus, SecurityDepositTransactionType} from '../models';
import {SecurityDepositTopupRequest} from '../models/security-deposit-topup-request.model';
import {CustomerSecurityDepositRepository, CustomerSecurityDepositTransactionRepository, SecurityDepositTopupRequestRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class SecurityDepositService {
  constructor(
    @repository(CustomerSecurityDepositRepository) private depositRepository: CustomerSecurityDepositRepository,
    @repository(CustomerSecurityDepositTransactionRepository) private depositTxRepository: CustomerSecurityDepositTransactionRepository,
    @repository(SecurityDepositTopupRequestRepository) private topupRequestRepository: SecurityDepositTopupRequestRepository,
  ) {}

  async createDeposit(customerId: string, options?: object): Promise<any> {
    return this.depositRepository.create({
      customerId,
      depositAmount: 0,
      availableBalance: 0,
      status: SecurityDepositStatus.ACTIVE,
    }, options);
  }

  async addAmount(depositId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const deposit = await this.depositRepository.findById(depositId, undefined, options);
    await this.depositRepository.updateById(depositId, {
      depositAmount: Number(deposit.depositAmount) + Number(amount),
      availableBalance: Number(deposit.availableBalance) + Number(amount),
    }, options);
    return this.depositTxRepository.create({
      securityDepositId: depositId,
      transactionType: SecurityDepositTransactionType.DEPOSIT,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
  }

  async deductAmount(depositId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const deposit = await this.depositRepository.findById(depositId, undefined, options);
    if (Number(deposit.availableBalance) < Number(amount)) {
      throw new HttpErrors.BadRequest('Insufficient security deposit balance.');
    }
    await this.depositRepository.updateById(depositId, {
      availableBalance: Number(deposit.availableBalance) - Number(amount),
    }, options);
    return this.depositTxRepository.create({
      securityDepositId: depositId,
      transactionType: SecurityDepositTransactionType.DEDUCTION,
      amount,
      referenceType,
      referenceId,
      remarks,
      transactionDate: new Date(),
    }, options);
  }

  // ─── Top-up flow ──────────────────────────────────────────────────────────

  async initiateTopup(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    remarks?: string,
  ): Promise<SecurityDepositTopupRequest> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Top-up amount must be greater than zero.');
    }

    const deposit = await this.depositRepository.findOne({where: {customerId}});
    if (!deposit) {
      throw new HttpErrors.NotFound('Security deposit account not found for this customer.');
    }
    if (deposit.status !== SecurityDepositStatus.ACTIVE) {
      throw new HttpErrors.BadRequest('Security deposit account is not active.');
    }

    const count = await this.topupRequestRepository.count({customerId});
    const requestNumber = `SDT${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    return this.topupRequestRepository.create({
      id: v4(),
      customerId,
      securityDepositId: deposit.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.PENDING,
      remarks,
    });
  }

  async confirmTopup(
    topupRequestId: string,
    customerId: string,
    paymentReferenceId?: string,
    gatewayResponse?: string,
  ): Promise<{topupRequest: SecurityDepositTopupRequest; availableBalance: number}> {
    const request = await this.topupRequestRepository.findById(topupRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Top-up request is already ${request.status}.`);
    }

    await this.topupRequestRepository.updateById(topupRequestId, {
      status: PaymentRequestStatus.SUCCESS,
      paymentReferenceId,
      gatewayResponse,
    });

    await this.addAmount(
      request.securityDepositId,
      request.amount,
      ReferenceType.MANUAL,
      topupRequestId,
      `Security deposit top-up - ${request.requestNumber}`,
    );

    const deposit = await this.depositRepository.findById(request.securityDepositId);
    const updatedRequest = await this.topupRequestRepository.findById(topupRequestId);

    return {topupRequest: updatedRequest, availableBalance: deposit.availableBalance!};
  }

  async cancelTopup(topupRequestId: string, customerId: string): Promise<void> {
    const request = await this.topupRequestRepository.findById(topupRequestId);

    if (request.customerId !== customerId) {
      throw new HttpErrors.Forbidden('Access denied.');
    }
    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new HttpErrors.BadRequest(`Cannot cancel a top-up request that is already ${request.status}.`);
    }

    await this.topupRequestRepository.updateById(topupRequestId, {
      status: PaymentRequestStatus.CANCELLED,
    });
  }

  async getTopupHistory(customerId: string, limit = 20, skip = 0): Promise<SecurityDepositTopupRequest[]> {
    return this.topupRequestRepository.find({
      where: {customerId},
      order: ['createdAt DESC'],
      limit,
      skip,
    });
  }

  // Returns the full transaction ledger (deposits + deductions) with current balance.
  async getDepositHistory(customerId: string, limit = 50, skip = 0): Promise<{balance: number; transactions: object[]}> {
    const deposit = await this.depositRepository.findOne({where: {customerId}});
    if (!deposit) {
      return {balance: 0, transactions: []};
    }

    const transactions = await this.depositTxRepository.find({
      where: {securityDepositId: deposit.id, isDeleted: false} as any,
      order: ['transactionDate DESC'],
      limit,
      skip,
    });

    return {
      balance: Number(deposit.availableBalance ?? 0),
      transactions,
    };
  }

  // Admin directly tops up — no pending phase since payment is already collected in-store
  async adminTopup(
    customerId: string,
    amount: number,
    paymentMode: PaymentMode,
    performedBy: string,
    remarks?: string,
  ): Promise<{topupRequest: SecurityDepositTopupRequest; availableBalance: number}> {
    if (amount <= 0) {
      throw new HttpErrors.BadRequest('Top-up amount must be greater than zero.');
    }

    const deposit = await this.depositRepository.findOne({where: {customerId}});
    if (!deposit) {
      throw new HttpErrors.NotFound('Security deposit account not found for this customer.');
    }
    if (deposit.status !== SecurityDepositStatus.ACTIVE) {
      throw new HttpErrors.BadRequest('Security deposit account is not active.');
    }

    const count = await this.topupRequestRepository.count({customerId});
    const requestNumber = `SDT${String(count.count + 1).padStart(6, '0')}`;
    const {v4} = await import('uuid');

    const topupRequest = await this.topupRequestRepository.create({
      id: v4(),
      customerId,
      securityDepositId: deposit.id,
      requestNumber,
      amount,
      paymentMode,
      status: PaymentRequestStatus.SUCCESS,
      performedBy,
      remarks,
    });

    await this.addAmount(
      deposit.id,
      amount,
      ReferenceType.MANUAL,
      topupRequest.id,
      `Admin security deposit top-up - ${requestNumber}`,
    );

    const updatedDeposit = await this.depositRepository.findById(deposit.id);
    return {topupRequest, availableBalance: updatedDeposit.availableBalance!};
  }
}
