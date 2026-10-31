import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ShiftController} from '../controllers/shift.controller';
import {ShiftStatus} from '../models/shift-status.enum';

function setupClose(actualSettlement: number) {
  let saved: {closing: {cardPgSettlement: {actualSettlement: number; expectedSettlement: number; difference: number}}} | undefined;
  const controller = Object.assign(Object.create(ShiftController.prototype), {
    shiftRepository: {
      findById: async () => ({
        id: 'shift-a',
        storeId: 'store-a',
        status: ShiftStatus.OPEN,
        openedAt: new Date('2026-10-01T09:00:00Z'),
      }),
      updateById: async (_id: string, record: typeof saved) => {
        saved = record;
      },
    },
    resolveCallerStore: async () => ({storeId: 'store-a', userName: 'Cashier'}),
    sanitizeDenominations: () => ({}),
    resolveNetRevenue: async () => ({revenue: {}, salesReturn: {}}),
    resolveOrderSummary: async () => ({}),
  }) as ShiftController;
  const closing = {
    remarks: 'done',
    collections: {cash: 0, card: 0, upi: 0, cheque: 0, pgLink: 0, ppVoucher: 0, wallet: 0},
    walletCollections: {cash: 0, card: 100, upi: 0, netBanking: 0, ppVoucher: 0},
    banking: {supposed: 0, deposited: 0, inSafe: 0},
    prepaidV: {supposed: 0, sentToAc: 0, inSafe: 0},
    pettyCash: {prevSupposed: 0, recvFromFinance: 0, used: 0, disapprovedAmt: 0, actualBalance: 0},
    cardPgSettlement: {actualSettlement, difference: 0},
    ppVoucher: {currSupVoucher: 0, actualVoucher: 0},
    register: {prevSupCashInTill: 0, prevActCashInTill: 0, cashReceived: 0, reimbursement: 0},
    actualCashInTill: {actual: 0},
    revenue: {},
    salesReturn: {},
  } as Parameters<ShiftController['close']>[2];
  return {controller, closing, saved: () => saved};
}

describe('shift Card and UPI settlement', () => {
  it('rejects a missing wallet Card settlement even when the client sends zero difference', async () => {
    const {controller, closing, saved} = setupClose(0);
    let error: Error | undefined;
    try {
      await controller.close({} as UserProfile, 'shift-a', closing);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).to.match(/Card & UPI Settlement difference must be zero/);
    expect(saved()).to.be.undefined();
  });

  it('stores its own expected amount and difference when balanced', async () => {
    const {controller, closing, saved} = setupClose(100);
    await controller.close({} as UserProfile, 'shift-a', closing);
    expect(saved()?.closing.cardPgSettlement).to.containEql({
      actualSettlement: 100,
      expectedSettlement: 100,
      difference: 0,
    });
  });
});
