/* eslint-disable @typescript-eslint/no-explicit-any -- Transactional repository doubles. */
import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {SalesReturnController} from '../controllers/sales-return.controller';

import {OrderService} from '../services/order.service';

const user = {[securityId]: 'staff'} as UserProfile;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function setup(paid = 750) {
  let state: any = {
    orders: [
      {
        id: 'order',
        customerId: 'customer',
        storeId: 'store',
        status: 'ready',
        isDeleted: false,
        subtotal: 1000,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: 1000,
      },
    ],
    invoices: [
      {
        id: 'invoice',
        orderId: 'order',
        status: 'issued',
        invoiceNumber: 'INV-1',
        subtotal: 1000,
        discount: 0,
        cgst: 0,
        sgst: 0,
        totalAmount: 1000,
        amountReceived: paid,
        balanceDue: Math.max(0, 1000 - paid),
        items: [300, 450, 250].map((value, i) => ({
          orderItemId: `item-${i}`,
          quantity: 1,
          totalPrice: value,
        })),
      },
    ],
    items: [300, 450, 250].map((value, i) => ({
      id: `item-${i}`,
      itemId: `catalog-${i}`,
      orderId: 'order',
      quantity: 1,
      totalPrice: value,
    })),
    garments: [0, 1, 2].map(i => ({
      id: `garment-${i}`,
      orderItemId: `item-${i}`,
      status: 'ready',
      isDeleted: false,
    })),
    payments: paid
      ? [
          {
            id: 'payment',
            orderId: 'order',
            amount: paid,
            transactionType: 'payment',
          },
        ]
      : [],
    notes: [],
    links: [],
    challans: [],
    refunds: [],
    history: [],
    wallet: 0,
  };
  function matches(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (key === 'and')
        return value.every((clause: any) => matches(row, clause));
      if (value && typeof value === 'object') {
        if (value.inq) return value.inq.includes(row[key]);
        if (value.nin) return !value.nin.includes(row[key]);
        if ('neq' in value) return row[key] !== value.neq;
      }
      return row[key] === value;
    });
  }
  const repo = (key: string) => ({
    count: async () => ({count: state[key].length}),
    find: async (filter: any) =>
      copy(state[key].filter((row: any) => matches(row, filter?.where))),
    findOne: async (filter: any) =>
      copy(state[key].find((row: any) => matches(row, filter?.where)) ?? null),
    findById: async (id: string) =>
      copy(state[key].find((row: any) => row.id === id)),
    create: async (row: any) => {
      state[key].push(copy(row));
      return copy(row);
    },
    updateById: async (id: string, fields: any) =>
      Object.assign(
        state[key].find((row: any) => row.id === id),
        copy(fields),
      ),
  });
  let queue = Promise.resolve();
  let failPayout = false;
  const controller: SalesReturnController = Object.assign(
    Object.create(SalesReturnController.prototype),
    {
      orderRepo: repo('orders'),
      invoiceRepo: repo('invoices'),
      invoiceOrderLinkRepo: repo('links'),
      orderItemRepo: repo('items'),
      garmentRepo: repo('garments'),
      salesReturnRepo: repo('notes'),
      paymentRepo: repo('payments'),
      refundDueRepo: repo('refunds'),
      challanRepo: repo('challans'),
      statusHistoryRepo: repo('history'),
      itemRepo: {find: async () => []},
      gstConfigRepo: {
        findOne: async () => ({cgstPercentage: 0, sgstPercentage: 0}),
      },
      storeScopeService: {assertOrderVisible: async () => undefined},
      dataSource: {
        beginTransaction: async () => {
          const tx: any = {locked: false};
          tx.commit = async () => tx.release?.();
          tx.rollback = async () => {
            if (tx.snapshot) state = tx.snapshot;
            tx.release?.();
          };
          return tx;
        },
        execute: async (sql: string, _args: unknown[], options: any) => {
          const tx = options.transaction;
          if (sql.includes('public.orders') && !tx.locked) {
            const previous = queue;
            queue = new Promise<void>(resolve => {
              tx.release = resolve;
            });
            await previous;
            tx.locked = true;
            tx.snapshot = copy(state);
          }
          return [{nextNumber: String(state.notes.length + 1)}];
        },
      },
      approvalService: {
        calculateGarmentReturnAmount: async (id: string) => ({
          itemPrice: [300, 450, 250][Number(id.slice(-1))],
          additionalServiceCharge: 0,
          addOnCharge: 0,
        }),
        executeRefundPayout: async (params: any, options: any) => {
          expect(options.transaction.locked).to.equal(true);
          state.payments.push({
            orderId: params.orderId,
            amount: params.amount,
            transactionType: 'refund',
            method: params.method,
          });
          if (params.method === 'wallet') state.wallet += params.amount;
          if (failPayout) throw new Error('payout failed');
        },
        availableCashForOrder: async () => 10000,
      },
    },
  );
  const request = async (
    item = 2,
    refundMethod: 'wallet' | 'cash' | 'bank_account' = 'wallet',
  ) =>
    controller.create(user, 'order', {
      reason: 'Service disputed',
      refundMethod,
      ...(refundMethod === 'bank_account'
        ? {
            bankDetails: {
              accountHolderName: 'Test Customer',
              bankName: 'Test Bank',
              accountNumber: '00000000',
              ifscCode: 'TEST0000000',
            },
          }
        : {}),
      returnedItems: [
        {
          orderItemId: `item-${item}`,
          quantity: 1,
          amount: [300, 450, 250][item],
        },
      ],
    }) as Promise<any>;
  // Emulate records created before immediate settlement was introduced.
  const pendingRequest = async (item = 2) => {
    const target = controller as any;
    const apply = target.applyCreditNote;
    target.applyCreditNote = async () => ({});
    try {
      return await request(item);
    } finally {
      target.applyCreditNote = apply;
    }
  };
  return {
    controller,
    request,
    pendingRequest,
    state: () => state,
    failPayout: () => {
      failPayout = true;
    },
  };
}

describe('system notification sales return settlement', () => {
  it('applies on submission and records approved Finance history using the existing invoice adjustment', async () => {
    const test = setup();
    const result = await test.request();
    expect(result.salesReturn).to.containEql({
      status: 'approved',
      resolvedBy: 'staff',
      refundAmount: 0,
      creditAppliedAs: 'adjustment',
    });
    expect(test.state().orders[0].totalAmount).to.equal(750);
    expect(test.state().invoices[0].totalAmount).to.equal(750);
    expect(test.state().invoices[0].balanceDue).to.equal(0);
    expect(test.state().wallet).to.equal(0);
  });
  it('retains an unpaid balance after a partial adjustment', async () => {
    const test = setup(700);
    await test.request();
    const service = Object.assign(Object.create(OrderService.prototype), {
      paymentTransactionRepo: {find: async () => test.state().payments},
    }) as OrderService;
    expect(
      (await service.computeBalanceDue(test.state().orders[0])).due,
    ).to.equal(50);
    expect(test.state().invoices[0].balanceDue).to.equal(50);
  });
  it('refunds only the excess immediately for partial and full payments', async () => {
    for (const paid of [900, 1000]) {
      const test = setup(paid);
      await test.request();
      expect(test.state().wallet).to.equal(paid - 750);
    }
  });
  it('does not introduce a requirement to generate a final invoice', async () => {
    const test = setup();
    test.state().invoices = [];
    await test.request();
    expect(test.state().orders[0].totalAmount).to.equal(750);
  });
  it('rolls back the note, billing, garments and wallet when payout fails', async () => {
    const test = setup(1000);
    test.failPayout();
    await expect(test.request()).to.be.rejectedWith('payout failed');
    expect(test.state().notes.length).to.equal(0);
    expect(test.state().orders[0].totalAmount).to.equal(1000);
    expect(test.state().invoices[0].totalAmount).to.equal(1000);
    expect(test.state().wallet).to.equal(0);
    expect(test.state().garments[2].status).to.equal('ready');
  });
  it('prevents repeat approval and rejection after immediate settlement', async () => {
    const test = setup(1000);
    const result = await test.request();
    await expect(
      test.controller.approve(user, result.salesReturn.id),
    ).to.be.rejectedWith(/already approved/);
    await expect(
      test.controller.reject(user, result.salesReturn.id),
    ).to.be.rejectedWith(/already approved/);
    expect(test.state().wallet).to.equal(250);
  });
  it('serializes duplicate submissions so the return and refund happen once', async () => {
    const test = setup(1000);
    const results = await Promise.allSettled([test.request(), test.request()]);
    expect(results.filter(r => r.status === 'fulfilled').length).to.equal(1);
    expect(test.state().notes.length).to.equal(1);
    expect(test.state().wallet).to.equal(250);
  });
  it('supports multiple returns without double-counting returned garments', async () => {
    const test = setup(1000);
    for (const item of [0, 1, 2]) await test.request(item);
    expect(test.state().orders[0].totalAmount).to.equal(0);
    expect(test.state().wallet).to.equal(1000);
  });
  it('keeps the older pending approval route functional', async () => {
    const test = setup(1000);
    const r = await test.pendingRequest();
    await test.controller.approve(user, r.salesReturn.id);
    expect(test.state().wallet).to.equal(250);
  });
  it('allows rejecting a legacy pending note without reducing the due', async () => {
    const test = setup();
    const r = await test.pendingRequest();
    await test.controller.reject(user, r.salesReturn.id);
    expect(test.state().notes[0].status).to.equal('rejected');
    expect(test.state().orders[0].totalAmount).to.equal(1000);
  });
  it('uses the selected cash or bank payout method immediately', async () => {
    for (const method of ['cash', 'bank_account'] as const) {
      const test = setup(1000);
      const r = await test.request(2, method);
      expect(r.salesReturn).to.containEql({
        status: 'approved',
        refundAmount: 250,
        creditAppliedAs: method,
      });
      expect(test.state().wallet).to.equal(0);
    }
  });
  it('rejects an invalid quantity or excessive credit before applying it', async () => {
    for (const line of [
      {quantity: 0, amount: 250},
      {quantity: 1, amount: 999999},
    ]) {
      const test = setup();
      await expect(
        test.controller.create(user, 'order', {
          reason: 'Invalid test',
          returnedItems: [{orderItemId: 'item-2', ...line}],
        }),
      ).to.be.rejected();
      expect(test.state().notes.length).to.equal(0);
      expect(test.state().orders[0].totalAmount).to.equal(1000);
    }
  });
});
