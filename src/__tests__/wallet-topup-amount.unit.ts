import {expect} from '@loopback/testlab';
import {PaymentMode} from '../models/payment-mode.enum';
import {roundWalletRechargeAmount, WalletService} from '../services/wallet.service';

describe('staff wallet recharge amount', () => {
  it('rounds down through 0.55 and up above 0.55', () => {
    expect(roundWalletRechargeAmount(501.01)).to.equal(501);
    expect(roundWalletRechargeAmount(501.55)).to.equal(501);
    expect(roundWalletRechargeAmount(501.56)).to.equal(502);
    expect(roundWalletRechargeAmount(501.55555)).to.equal(502);
  });

  it('rejects amounts that would round to zero', () => {
    expect(() => roundWalletRechargeAmount(0.55)).to.throw(
      'Recharge amount must round to at least one rupee.',
    );
  });

  it('stores and credits the same whole amount for every staff payment mode', async () => {
    const storedAmounts: number[] = [];
    const creditedAmounts: number[] = [];
    const service = Object.assign(Object.create(WalletService.prototype), {
      walletRepository: {
        findOne: async () => ({id: 'wallet'}),
        findById: async () => ({currentBalance: 502}),
      },
      rechargeRequestRepository: {
        count: async () => ({count: 0}),
        create: async (request: {amount: number}) => {
          storedAmounts.push(request.amount);
          return request;
        },
      },
      credit: async (_walletId: string, amount: number) => {
        creditedAmounts.push(amount);
        return {id: 'transaction', transactionDate: new Date()};
      },
      whatsAppService: {notifyWalletRecharge: async () => undefined},
    }) as WalletService;

    for (const mode of [
      PaymentMode.CASH,
      PaymentMode.UPI,
      PaymentMode.CARD,
      PaymentMode.NET_BANKING,
      PaymentMode.PP_VOUCHER,
    ]) {
      await service.adminRecharge('customer', 501.56, mode, 'staff');
    }

    expect(storedAmounts).to.deepEqual([502, 502, 502, 502, 502]);
    expect(creditedAmounts).to.deepEqual(storedAmounts);
  });

  it('rejects modes that shift closure cannot account for', async () => {
    const service = Object.create(WalletService.prototype) as WalletService;
    try {
      await service.adminRecharge('customer', 500, PaymentMode.BANK_TRANSFER, 'staff');
      throw new Error('Unsupported recharge mode was accepted.');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Unsupported wallet recharge payment mode.',
      );
    }
  });
});
