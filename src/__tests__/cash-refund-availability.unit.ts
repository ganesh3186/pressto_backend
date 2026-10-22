import {expect} from '@loopback/testlab';
import {ApprovalService} from '../services/approval.service';
import {RefundMethod} from '../models/refund-method.enum';

describe('cash refund availability', () => {
  it('pays a different order store from the selected open shift and records that shift', async () => {
    const created: Array<{cashShiftId?: string}> = [];
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      orderRepo: {
        findById: async () => ({id: 'order-a', storeId: 'store-a'}),
        find: async () => [{id: 'order-b'}],
      },
      shiftRepo: {
        findById: async () => ({id: 'shift-b', storeId: 'store-b', userId: 'cashier-b',
          status: 'open', openedAt: new Date('2026-10-22T09:00:00Z')}),
      },
      paymentRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.cashShiftId ? [] : [{orderId: 'order-b', amount: 590, transactionType: 'payment'}],
        create: async (payment: {cashShiftId?: string}) => { created.push(payment); },
      },
      riderCashHandoverRepo: {find: async () => []},
      walletRechargeRequestRepo: {find: async () => [{amount: 500}]},
    }) as ApprovalService;

    expect(await service.availableCashForOrder('order-a', 'shift-b')).to.equal(1090);
    await service.executeRefundPayout({
      customerId: 'customer-a', orderId: 'order-a', amount: 100,
      method: 'cash', cashShiftId: 'shift-b', remarks: 'Sales Return',
    });
    expect(created[0].cashShiftId).to.equal('shift-b');
  });

  it('uses cash collected this shift without opening till cash and blocks larger payouts', async () => {
    const created: object[] = [];
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      orderRepo: {
        findById: async () => ({id: 'order-a', storeId: 'store-a'}),
        find: async () => [{id: 'order-a'}],
      },
      shiftRepo: {
        findOne: async () => ({
          id: 'shift-a',
          status: 'open',
          storeId: 'store-a',
          userId: 'cashier-a',
          openedAt: new Date('2026-10-22T09:00:00Z'),
          opening: {cashInTill: {actual: 100}},
        }),
        findById: async () => ({
          id: 'shift-a', status: 'open', storeId: 'store-a', userId: 'cashier-a',
          openedAt: new Date('2026-10-22T09:00:00Z'),
        }),
      },
      paymentRepo: {
        find: async ({where}: {where: Record<string, unknown>}) => where.cashShiftId ? [] : [
          {amount: 200, transactionType: 'payment'},
          {amount: 75, transactionType: 'refund'},
        ],
        create: async (payment: object) => created.push(payment),
      },
      riderCashHandoverRepo: {find: async () => [{totalAmount: 25}]},
      walletRechargeRequestRepo: {find: async () => [{amount: 50}]},
    }) as ApprovalService;

    expect(await service.availableCashForOrder('order-a')).to.equal(200);
    const payout = {
      customerId: 'customer-a',
      orderId: 'order-a',
      amount: 200,
      method: 'cash',
      remarks: 'Return Item',
    };
    await service.executeRefundPayout(payout);
    expect(created[0]).to.containEql({amount: 200, transactionType: 'refund'});
    await expect(service.executeRefundPayout({...payout, amount: 200.01})).to.be.rejectedWith(
      'Cash refund exceeds available cash in the store.',
    );
    expect(created).to.have.length(1);
  });

  it('uses the next open shift at the selected store when approval happens after closure', async () => {
    const created: Array<{cashShiftId?: string}> = [];
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      orderRepo: {
        findById: async () => ({id: 'order-a', storeId: 'ticket-store'}),
        find: async () => [{id: 'store-order'}],
      },
      shiftRepo: {
        findById: async () => ({id: 'old-shift', storeId: 'payout-store', status: 'closed'}),
        findOne: async () => ({id: 'new-shift', storeId: 'payout-store', status: 'open',
          openedAt: new Date('2026-10-23T09:00:00Z')}),
      },
      paymentRepo: {
        find: async ({where}: {where: Record<string, unknown>}) =>
          where.cashShiftId ? [] : [{amount: 120, transactionType: 'payment'}],
        create: async (payment: {cashShiftId?: string}) => { created.push(payment); },
      },
      riderCashHandoverRepo: {find: async () => []},
      walletRechargeRequestRepo: {find: async () => []},
    }) as ApprovalService;

    expect(await service.availableCashForOrder('order-a', 'old-shift')).to.equal(120);
    await service.executeRefundPayout({
      customerId: 'customer-a', orderId: 'order-a', amount: 100,
      method: 'cash', cashShiftId: 'old-shift', remarks: 'Return Item',
    });
    expect(created[0].cashShiftId).to.equal('new-shift');
  });

  it('does not request a cash payout when the return exceeds available cash', async () => {
    let requested = false;
    const service = Object.assign(Object.create(ApprovalService.prototype), {
      refundDueRepo: {
        findById: async () => ({id: 'refund-a', orderId: 'order-a', status: 'pending', amount: 80}),
      },
      reconcileRefundDueAmount: async () => 80,
      availableCashForOrder: async () => 75,
      createRequest: async () => { requested = true; },
    }) as ApprovalService;

    await expect(service.selectPayoutMethod({
      refundDueId: 'refund-a', method: RefundMethod.CASH, requestedBy: 'cashier-a',
    })).to.be.rejectedWith('Cash refund exceeds available cash in the store.');
    expect(requested).to.equal(false);
  });
});
