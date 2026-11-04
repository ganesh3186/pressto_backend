import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ShiftController} from '../controllers/shift.controller';

describe('shift opening Cash In Till limit', () => {
  it('accepts ₹4,000 and rejects amounts outside ₹0–₹4,000 before saving', async () => {
    let saved: {opening: {cashInTill: {actual: number}}} | undefined;
    const controller = Object.assign(Object.create(ShiftController.prototype), {
      resolveCallerStore: async () => ({storeId: 'store-a', storeCode: 'A', storeName: 'Store A', userId: 'user-a', userName: 'Cashier'}),
      resolveSupposedOpeningValues: async () => ({cashInTill: 2000, banking: 0, pettyCash: 0, prepaidVouchers: 0}),
      dataSource: {
        beginTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
        execute: async () => [],
      },
      shiftRepository: {
        findOne: async () => null,
        count: async () => ({count: 0}),
        create: async (record: typeof saved) => {
          saved = record;
          return record;
        },
      },
    }) as ShiftController;
    const body = {
      remarks: 'Opening count',
      openingBalances: {
        cashInTill: {actual: 4000},
        banking: {actual: 0},
        pettyCash: {actual: 0},
        prepaidVouchers: {actual: 0},
      },
    } as Parameters<ShiftController['open']>[1];

    await controller.open({} as UserProfile, body);
    expect(saved?.opening.cashInTill.actual).to.equal(4000);

    for (const actual of [-1, 4001]) {
      saved = undefined;
      body.openingBalances.cashInTill.actual = actual;
      let error: {statusCode?: number} | undefined;
      try {
        await controller.open({} as UserProfile, body);
      } catch (caught) {
        error = caught as {statusCode: number};
      }
      expect(error?.statusCode).to.equal(400);
      expect(saved).to.be.undefined();
    }
  });
});
