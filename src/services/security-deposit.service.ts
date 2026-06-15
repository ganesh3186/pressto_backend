import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ReferenceType, SecurityDepositStatus, SecurityDepositTransactionType} from '../models';
import {CustomerSecurityDepositRepository, CustomerSecurityDepositTransactionRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class SecurityDepositService {
  constructor(
    @repository(CustomerSecurityDepositRepository) private depositRepository: CustomerSecurityDepositRepository,
    @repository(CustomerSecurityDepositTransactionRepository) private depositTxRepository: CustomerSecurityDepositTransactionRepository,
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
    const deposit = await this.depositRepository.findById(depositId);
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
    const deposit = await this.depositRepository.findById(depositId);
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
}
