import {expect} from '@loopback/testlab';
import {ReportsService} from '../services/reports.service';

describe('petty cash expense report', () => {
  it('keeps pending and approved description totals across pages', async () => {
    const entries = [
      {id: '1', description: 'Office Supplies', amount: 100.1},
      {id: '2', description: 'Transport', amount: 2500},
      {id: '3', description: 'Office Supplies', amount: 149.9},
      {
        id: '4',
        description: 'Office Supplies',
        amount: 100,
        approvedAmount: 60,
        disapprovedAmt: 40,
        status: 'Approved',
      },
      {
        id: '5',
        description: 'DGT',
        amount: 50,
        approvedAmount: 0,
        disapprovedAmt: 50,
        status: 'Rejected',
      },
    ];
    const service = Object.assign(Object.create(ReportsService.prototype), {
      pettyCashRegisterRepo: {find: async () => entries},
      shiftRepo: {find: async () => []},
    }) as ReportsService;
    const report = await service.buildPettyCashExpense({
      storeIds: ['store-a'],
      from: new Date('2026-10-01'),
      to: new Date('2026-10-31'),
      limit: 1,
      skip: 0,
    });
    expect(report.rows).to.have.length(1);
    expect(report.totalCount).to.equal(5);
    expect(report.totalsByDescription).to.deepEqual({
      'Office Supplies': 310,
      Transport: 2500,
    });
  });

  it('shows shift events and finance receipts oldest first across pages', async () => {
    const entries = [
      {
        id: '1',
        storeId: 'store-a',
        expenseDate: new Date('2026-10-17T10:00:00Z'),
        createdAt: new Date('2026-10-17T10:00:00Z'),
        description: 'Petrol',
        amount: 100,
        approvedAmount: 100,
        status: 'Approved',
      },
      {
        id: '2',
        storeId: 'store-a',
        expenseDate: new Date('2026-10-17T11:00:00Z'),
        createdAt: new Date('2026-10-17T11:00:00Z'),
        description: 'DGT',
        amount: 50,
        approvedAmount: 0,
        disapprovedAmt: 50,
        status: 'Rejected',
      },
      {
        id: '3',
        storeId: 'store-a',
        expenseDate: new Date('2026-10-17T12:00:00Z'),
        createdAt: new Date('2026-10-17T12:00:00Z'),
        description: 'Vehicle',
        amount: 30,
        approvedAmount: 30,
        status: 'Approved',
      },
    ];
    const service = Object.assign(Object.create(ReportsService.prototype), {
      pettyCashRegisterRepo: {find: async () => entries},
      pettyCashFinanceRepo: {
        find: async () => [
          {
            id: 'finance-1',
            storeId: 'store-a',
            amount: 20,
            createdAt: new Date('2026-10-17T11:30:00Z'),
          },
        ],
      },
      shiftRepo: {
        find: async () => [
          {
            id: 'shift-1',
            storeId: 'store-a',
            openingNo: 12,
            openedAt: new Date('2026-10-17T09:00:00Z'),
            closedAt: new Date('2026-10-17T17:00:00Z'),
            opening: {pettyCash: {supposed: 500, actual: 500}},
            closing: {pettyCash: {actualBalance: 390, difference: 0}},
          },
        ],
      },
    }) as ReportsService;
    const params = {
      storeIds: ['store-a'],
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-17T23:59:59Z'),
      limit: 2,
    };
    const first = await service.buildPettyCashExpense({...params, skip: 0});
    const second = await service.buildPettyCashExpense({...params, skip: 2});
    const third = await service.buildPettyCashExpense({...params, skip: 4});
    expect(first.totalCount).to.equal(6);
    expect(first.rows[0]).to.containEql({
      id: 'opening-shift-1',
      expenseDate: new Date('2026-10-17T09:00:00Z'),
      openingAmount: 500,
      shiftOpenDiff: 0,
      balance: 500,
    });
    expect(first.rows[1]).to.containEql({
      id: '1',
      balance: 400,
    });
    expect(first.rows[1]).not.to.have.property('openingAmount');
    expect(second.rows[0]).to.containEql({
      id: '2',
      shiftDisapprovedAmt: 50,
      balance: 400,
    });
    expect(second.rows[1]).to.containEql({
      id: 'finance-finance-1',
      entryType: 'finance',
      financeAmount: 20,
      balance: 420,
    });
    expect(second.rows[1]).not.to.have.property('openingAmount');
    expect(third.rows[0]).to.containEql({
      id: '3',
      balance: 390,
    });
    expect(third.rows[0]).not.to.have.property('closingAmount');
    expect(third.rows[1]).to.containEql({
      id: 'closing-shift-1',
      expenseDate: new Date('2026-10-17T17:00:00Z'),
      closingAmount: 390,
      balance: 390,
    });
  });

  it('shows a finance receipt even when the shift has no expense claim', async () => {
    const service = Object.assign(Object.create(ReportsService.prototype), {
      pettyCashRegisterRepo: {find: async () => []},
      pettyCashFinanceRepo: {
        find: async () => [
          {
            id: 'finance-1',
            storeId: 'store-a',
            amount: 100,
            createdAt: new Date('2026-10-17T10:00:00Z'),
          },
        ],
      },
      shiftRepo: {
        find: async () => [
          {
            id: 'shift-1',
            storeId: 'store-a',
            openingNo: 12,
            openedAt: new Date('2026-10-17T09:00:00Z'),
            closedAt: new Date('2026-10-17T17:00:00Z'),
            opening: {pettyCash: {actual: 500}},
            closing: {pettyCash: {actualBalance: 600}},
          },
        ],
      },
    }) as ReportsService;
    const report = await service.buildPettyCashExpense({
      storeIds: ['store-a'],
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-17T23:59:59Z'),
      limit: 25,
      skip: 0,
    });
    expect(report.totalCount).to.equal(3);
    expect(report.rows[0]).to.containEql({
      id: 'opening-shift-1',
      openingAmount: 500,
      balance: 500,
    });
    expect(report.rows[1]).to.containEql({
      entryType: 'finance',
      financeAmount: 100,
      balance: 600,
    });
    expect(report.rows[2]).to.containEql({
      id: 'closing-shift-1',
      closingAmount: 600,
      balance: 600,
    });
  });

  it('shows opening finance without adding it to the opening balance twice', async () => {
    const openedAt = new Date('2026-10-17T09:00:00Z');
    const service = Object.assign(Object.create(ReportsService.prototype), {
      pettyCashRegisterRepo: {find: async () => []},
      pettyCashFinanceRepo: {
        find: async () => [
          {
            id: 'opening-top-up',
            storeId: 'store-a',
            amount: 50,
            createdAt: openedAt,
          },
        ],
      },
      shiftRepo: {
        find: async () => [
          {
            id: 'shift-1',
            storeId: 'store-a',
            openingNo: 12,
            openedAt,
            opening: {pettyCash: {actual: 500}},
          },
        ],
      },
    }) as ReportsService;
    const report = await service.buildPettyCashExpense({
      storeIds: ['store-a'],
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-17T23:59:59Z'),
      limit: 25,
      skip: 0,
    });
    expect(report.rows[0]).to.containEql({
      entryType: 'opening',
      openingAmount: 500,
      balance: 500,
    });
    expect(report.rows[1]).to.containEql({
      description: 'Opening Finance Adjustment',
      financeAmount: 50,
      balance: 500,
    });
  });

  it('shows shift opening and closing even without petty cash activity', async () => {
    const service = Object.assign(Object.create(ReportsService.prototype), {
      pettyCashRegisterRepo: {find: async () => []},
      pettyCashFinanceRepo: {find: async () => []},
      shiftRepo: {
        find: async () => [
          {
            id: 'shift-1',
            openedAt: new Date('2026-10-17T09:00:00Z'),
            closedAt: new Date('2026-10-17T17:00:00Z'),
            opening: {pettyCash: {actual: 500}},
            closing: {pettyCash: {actualBalance: 500}},
          },
        ],
      },
    }) as ReportsService;
    const report = await service.buildPettyCashExpense({
      storeIds: ['store-a'],
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-17T23:59:59Z'),
      limit: 25,
      skip: 0,
    });
    expect(report.rows).to.have.length(2);
    expect(report.totalCount).to.equal(2);
    expect(report.rows[0]).to.containEql({
      entryType: 'opening',
      openingAmount: 500,
      balance: 500,
    });
    expect(report.rows[1]).to.containEql({
      entryType: 'closing',
      closingAmount: 500,
      balance: 500,
    });
  });
});
