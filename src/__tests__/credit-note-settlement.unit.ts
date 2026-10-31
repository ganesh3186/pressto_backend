/* eslint-disable @typescript-eslint/no-explicit-any -- Transactional repository doubles. */
import {expect} from '@loopback/testlab';
import {securityId, UserProfile} from '@loopback/security';
import {
  SalesReturnController,
  invoiceCreditValue,
} from '../controllers/sales-return.controller';

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
      orderService: {getOrderDetails: async () => ({items: state.items.map((item: any) => ({
        ...item, garments: state.garments.filter((garment: any) => garment.orderItemId === item.id),
      }))})},
      gstConfigRepo: {
        findOne: async () => ({cgstPercentage: 20, sgstPercentage: 20}),
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
    preview = false,
    refundMethod: 'wallet' | 'cash' | 'bank_account' = 'wallet',
  ) =>
    controller.create(
      user,
      'order',
      {
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
          {orderItemId: `item-${item}`, quantity: 1, amount: 999999},
        ],
      },
      preview,
    ) as Promise<any>;
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

describe('invoiced credit-note settlement', () => {
  it('credits two explicitly selected garments from one line without changing the issued invoice', async () => {
    const test = setup(1000);
    const state = test.state();
    state.items = state.items.filter((item: any) => item.id !== 'item-0');
    Object.assign(state.items.find((item: any) => item.id === 'item-2'), {quantity: 2, totalPrice: 550});
    state.garments[0].orderItemId = 'item-2';
    state.invoices[0].items = state.invoices[0].items.filter((item: any) => item.orderItemId !== 'item-0');
    Object.assign(state.invoices[0].items.find((item: any) => item.orderItemId === 'item-2'), {quantity: 2, totalPrice: 550});
    const result = await test.controller.create(user, 'order', {
      reason: 'Return selected pieces', returnedItems: [
        {orderItemId: 'item-2', garmentId: 'garment-0', quantity: 1, amount: 999999},
        {orderItemId: 'item-2', garmentId: 'garment-2', quantity: 1, amount: 999999},
      ],
    }) as any;
    expect(result.salesReturn.creditAmount).to.equal(550);
    expect(state.notes[0].returnedItems.map((line: any) => [line.garmentId, line.originalAmount])).to.eql([
      ['garment-0', 300], ['garment-2', 250],
    ]);
    expect(state.invoices[0].totalAmount).to.equal(1000);
    expect(state.orders[0].totalAmount).to.equal(450);
    expect(state.garments[1].status).to.equal('ready');
  });

  it('rejects a duplicate garment selection before creating a credit note', async () => {
    const test = setup(1000);
    await expect(test.controller.create(user, 'order', {reason: 'Duplicate', returnedItems: [
      {orderItemId: 'item-2', garmentId: 'garment-2', quantity: 1, amount: 250},
      {orderItemId: 'item-2', garmentId: 'garment-2', quantity: 1, amount: 250},
    ]})).to.be.rejectedWith(/once/);
    expect(test.state().notes).to.have.length(0);
  });

  it('previews liability reduction without creating a credit or moving money', async () => {
    const test = setup();
    const result = await test.request(2, true);
    expect(result.quote).to.containEql({
      creditAmount: 250,
      refundAmount: 0,
      newBalanceDue: 0,
    });
    expect(test.state().notes.length).to.equal(0);
    expect(test.state().orders[0].totalAmount).to.equal(1000);
  });

  it('settles 1000 with 750 received and 250 credit, preserving the invoice', async () => {
    const test = setup();
    const result = await test.request();
    const state = test.state();
    expect(result.salesReturn.status).to.equal('approved');
    expect(result.salesReturn.resolvedBy).to.equal('staff');
    expect(state.orders[0].totalAmount).to.equal(750);
    expect(state.invoices[0].totalAmount).to.equal(1000);
    expect(state.invoices[0].balanceDue).to.equal(0);
    expect(state.payments.length).to.equal(1);
    expect(state.wallet).to.equal(0);
    expect(state.notes[0]).to.containEql({
      refundAmount: 0,
      creditAppliedAs: 'adjustment',
      status: 'approved',
    });
  });

  it('keeps the remaining 50 payable when only 700 was received', async () => {
    const test = setup(700);
    await test.request();
    expect(test.state().invoices[0].balanceDue).to.equal(50);
    expect(test.state().wallet).to.equal(0);
  });

  it('refunds only the excess, including a partially paid ticket overpaid after credit', async () => {
    for (const paid of [900, 1000]) {
      const test = setup(paid);
      await test.request();
      expect(test.state().wallet).to.equal(paid - 750);
      expect(test.state().invoices[0].totalAmount).to.equal(1000);
      expect(test.state().invoices[0].balanceDue).to.equal(0);
    }
  });

  it('rechecks payments received while approval was pending', async () => {
    const test = setup();
    const result = await test.pendingRequest();
    test.state().payments.push({
      orderId: 'order',
      amount: 250,
      transactionType: 'payment',
    });
    await test.controller.approve(user, result.salesReturn.id);
    expect(test.state().wallet).to.equal(250);
  });

  it('rejects repeat approvals and serializes concurrent approvals without duplicate refunds', async () => {
    const test = setup(1000);
    const result = await test.pendingRequest();
    const outcomes = await Promise.allSettled([
      test.controller.approve(user, result.salesReturn.id),
      test.controller.approve(user, result.salesReturn.id),
    ]);
    expect(
      outcomes.filter(outcome => outcome.status === 'fulfilled').length,
    ).to.equal(1);
    expect(test.state().wallet).to.equal(250);
  });

  it('rolls all financial and garment changes back if payout fails', async () => {
    const test = setup(1000);
    const result = await test.pendingRequest();
    test.failPayout();
    await expect(
      test.controller.approve(user, result.salesReturn.id),
    ).to.be.rejectedWith('payout failed');
    expect(test.state().orders[0].totalAmount).to.equal(1000);
    expect(test.state().garments[2].status).to.equal('ready');
    expect(test.state().wallet).to.equal(0);
    expect(test.state().notes[0].status).to.equal('pending');
  });

  it('reserves pending quantities, releases rejected requests, and supports multiple credits', async () => {
    const test = setup(1000);
    const first = await test.pendingRequest();
    await expect(test.request()).to.be.rejected();
    await test.controller.reject(user, first.salesReturn.id);
    await test.request();
    await test.request(0);
    expect(test.state().orders[0].totalAmount).to.equal(450);
    expect(test.state().wallet).to.equal(550);
    expect(test.state().invoices[0].totalAmount).to.equal(1000);
  });

  it('requires a final invoice and an eligible ticket', async () => {
    const test = setup();
    test.state().invoices[0].status = 'draft';
    await expect(test.request()).to.be.rejectedWith(/final invoice/);
    test.state().invoices[0].status = 'issued';
    test.state().orders[0].status = 'cancelled';
    await expect(test.request()).to.be.rejectedWith(/Ready or later/);
  });

  it('fully credits an unpaid invoice without creating a refund', async () => {
    const test = setup(0);
    for (const item of [0, 1, 2]) {
      await test.request(item);
    }
    expect(test.state().orders[0].totalAmount).to.equal(0);
    expect(test.state().invoices[0].balanceDue).to.equal(0);
    expect(test.state().invoices[0].totalAmount).to.equal(1000);
    expect(test.state().payments.length).to.equal(0);
    expect(test.state().wallet).to.equal(0);
  });

  it('allocates rounding across successive credits without leaving a rupee due', async () => {
    const test = setup(0);
    test.state().orders[0].subtotal = 999.99;
    test.state().invoices[0].subtotal = 999.99;
    for (const item of test.state().invoices[0].items) item.totalPrice = 333.33;
    for (const item of [0, 1, 2]) {
      await test.request(item);
    }
    expect(
      test
        .state()
        .notes.reduce((sum: number, note: any) => sum + note.creditAmount, 0),
    ).to.equal(1000);
    expect(test.state().invoices[0].balanceDue).to.equal(0);
    expect(test.state().orders[0].totalAmount).to.equal(0);
  });

  it('exposes the credited balance to the delivery payment guard', async () => {
    for (const paid of [700, 750]) {
      const test = setup(paid);
      await test.request();
      const service = Object.assign(Object.create(OrderService.prototype), {
        paymentTransactionRepo: {find: async () => test.state().payments},
      }) as OrderService;
      const balance = await service.computeBalanceDue(test.state().orders[0]);
      expect(balance.due).to.equal(paid === 700 ? 50 : 0);
    }
  });

  it('rolls back creation as well as money and garment updates if immediate payout fails', async () => {
    const test = setup(1000);
    test.failPayout();
    await expect(test.request()).to.be.rejectedWith('payout failed');
    expect(test.state().notes.length).to.equal(0);
    expect(test.state().orders[0].totalAmount).to.equal(1000);
    expect(test.state().invoices[0].balanceDue).to.equal(0);
    expect(test.state().garments[2].status).to.equal('ready');
    expect(test.state().wallet).to.equal(0);
    expect(test.state().payments.length).to.equal(1);
  });

  it('serializes simultaneous submissions so a piece and refund are applied once', async () => {
    const test = setup(1000);
    const results = await Promise.allSettled([test.request(), test.request()]);
    expect(
      results.filter(result => result.status === 'fulfilled').length,
    ).to.equal(1);
    expect(test.state().notes.length).to.equal(1);
    expect(test.state().wallet).to.equal(250);
  });

  it('keeps automatically applied credits as approved history with no approve or reject mutation', async () => {
    const test = setup(1000);
    const result = await test.request();
    await expect(
      test.controller.approve(user, result.salesReturn.id),
    ).to.be.rejectedWith(/already approved/);
    await expect(
      test.controller.reject(user, result.salesReturn.id),
    ).to.be.rejectedWith(/already approved/);
    expect(test.state().notes[0].status).to.equal('approved');
    expect(test.state().wallet).to.equal(250);
    expect(test.state().orders[0].totalAmount).to.equal(750);
  });

  it('immediately records the selected cash or bank refund without a wallet credit', async () => {
    for (const method of ['cash', 'bank_account'] as const) {
      const test = setup(1000);
      const result = await test.request(2, false, method);
      expect(result.salesReturn).to.containEql({
        status: 'approved',
        refundAmount: 250,
        creditAppliedAs: method,
      });
      expect(test.state().wallet).to.equal(0);
      expect(
        test
          .state()
          .payments.filter(
            (payment: any) => payment.transactionType === 'refund',
          ),
      ).to.eql([
        {orderId: 'order', amount: 250, transactionType: 'refund', method},
      ]);
    }
  });

  it('uses saved discount and GST independently of cash collected', () => {
    expect(
      invoiceCreditValue(250, {
        subtotal: 1000,
        discount: 100,
        tax: 162,
        total: 1062,
      }),
    ).to.eql({amount: 225, taxAmount: 40.5, grossAmount: 265.5});
  });
});
