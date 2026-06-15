import {BindingScope, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {ReferenceType, WalletTransactionType} from '../models';
import {WalletRepository, WalletTransactionRepository} from '../repositories';

@injectable({scope: BindingScope.TRANSIENT})
export class WalletService {
  constructor(
    @repository(WalletRepository) private walletRepository: WalletRepository,
    @repository(WalletTransactionRepository) private walletTransactionRepository: WalletTransactionRepository,
  ) {}

  async createWallet(customerId: string, options?: object): Promise<any> {
    return this.walletRepository.create({customerId, currentBalance: 0}, options);
  }

  async credit(walletId: string, amount: number, referenceType: ReferenceType, referenceId?: string, remarks?: string, options?: object): Promise<any> {
    const wallet = await this.walletRepository.findById(walletId);
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
    const wallet = await this.walletRepository.findById(walletId);
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
}
