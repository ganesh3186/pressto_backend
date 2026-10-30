import {expect} from '@loopback/testlab';
import {PaymentMode, ReferenceType, WalletTransaction, WalletTransactionType} from '../models';
import {WalletService} from '../services/wallet.service';

describe('wallet history payment mode', () => {
  it('adds recharge modes to credits and leaves debits without a mode', async () => {
    const transactions = [
      new WalletTransaction({
        id: 'credit-1',
        referenceType: ReferenceType.MANUAL,
        referenceId: 'recharge-1',
        transactionType: WalletTransactionType.CREDIT,
        amount: 500,
      }),
      new WalletTransaction({
        id: 'debit-1',
        referenceType: ReferenceType.ORDER,
        transactionType: WalletTransactionType.DEBIT,
        amount: 100,
      }),
    ];
    let rechargeQuery: object | undefined;
    const service = Object.assign(Object.create(WalletService.prototype), {
      walletRepository: {findOne: async () => ({id: 'wallet-1', currentBalance: 400})},
      walletTransactionRepository: {find: async () => transactions},
      rechargeRequestRepository: {
        find: async (query: object) => {
          rechargeQuery = query;
          return [{id: 'recharge-1', paymentMode: PaymentMode.CASH, performedBy: 'staff-1'}];
        },
      },
      usersRepository: {find: async () => [{id: 'staff-1', fullName: 'Past cashier'}]},
    }) as WalletService;

    const history = await service.getWalletHistory('customer-1');

    expect(rechargeQuery).to.containDeep({where: {id: {inq: ['recharge-1']}, customerId: 'customer-1'}});
    expect(history.transactions).to.containDeep([
      {id: 'credit-1', paymentMode: PaymentMode.CASH, performedByName: 'Past cashier'},
      {id: 'debit-1'},
    ]);
    expect((history.transactions[1] as {paymentMode?: PaymentMode}).paymentMode).to.be.undefined();
  });
});
