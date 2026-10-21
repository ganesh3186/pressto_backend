import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ReportsController} from '../controllers/reports.controller';

describe('report store filters', () => {
  const user = {} as UserProfile;
  const captured: string[][] = [];
  let global = false;
  const controller = Object.assign(Object.create(ReportsController.prototype), {
    reportsService: {
      buildModeOfPayment: async ({storeIds}: {storeIds: string[]}) => {
        captured.push(storeIds);
        return {rows: [], totalCount: 0, totals: {}, totalsByMode: {}};
      },
      buildPettyCashExpense: async ({storeIds}: {storeIds: string[]}) => {
        captured.push(storeIds);
        return {rows: [], totalCount: 0, totals: {}};
      },
      buildConsolidatedDailySales: async ({storeIds}: {storeIds: string[]}) => {
        captured.push(storeIds);
        return {rows: [], totalCount: 0, totals: {}};
      },
      buildSalesGst: async ({storeIds}: {storeIds: string[]}) => {
        captured.push(storeIds);
        return {rows: [], totalCount: 0, totals: {}};
      },
    },
    storeScopeService: {
      resolve: async () => ({global, storeIds: ['store-a', 'store-b']}),
      narrowStoreIds: async (_scope: object, {storeId}: {storeId?: string}) =>
        storeId ? [storeId] : global ? null : ['store-a', 'store-b'],
    },
    storeRepo: {
      find: async () => [{id: 'store-a'}, {id: 'store-b'}, {id: 'store-c'}],
    },
  }) as ReportsController;

  const request = (storeId?: string, storeIds?: string) =>
    controller.pettyCashExpense(
      user,
      storeId,
      storeIds,
      '2026-10-01',
      '2026-10-02',
    );

  const requestMode = (storeId?: string, storeIds?: string) =>
    controller.modeOfPayment(
      user,
      storeId,
      storeIds,
      '2026-10-01',
      '2026-10-02',
    );

  const requestDailySales = (storeId?: string, storeIds?: string) =>
    controller.consolidatedDailySales(
      user,
      storeId,
      storeIds,
      '2026-10-01',
      '2026-10-02',
    );

  it('applies the same scoped multi-store filter to consolidated daily sales', async () => {
    global = false;
    await requestDailySales();
    await requestDailySales(undefined, 'store-b, store-c');
    expect(captured.slice(-2)).to.deepEqual([
      ['store-a', 'store-b'],
      ['store-b'],
    ]);

    global = true;
    await requestDailySales(undefined, 'store-c, store-a');
    expect(captured[captured.length - 1]).to.deepEqual(['store-c', 'store-a']);
  });

  it('uses the same All Stores and selected-store rules for mode of payment', async () => {
    global = false;
    await requestMode();
    await requestMode(undefined, 'store-b, store-c');
    expect(captured.slice(-2)).to.deepEqual([
      ['store-a', 'store-b'],
      ['store-b'],
    ]);

    global = true;
    await requestMode();
    await requestMode('store-a');
    expect(captured.slice(-2)).to.deepEqual([
      ['store-a', 'store-b', 'store-c'],
      ['store-a'],
    ]);
  });

  it('keeps the GST state filter within the caller’s store scope', async () => {
    global = false;
    await controller.salesGst(user, 'store-a', '2026-10-01', '2026-10-02');
    expect(captured[captured.length - 1]).to.deepEqual(['store-a']);

    await controller.salesGst(
      user,
      undefined,
      '2026-10-01',
      '2026-10-02',
      undefined,
      undefined,
      undefined,
      'store-b,store-c',
    );
    expect(captured[captured.length - 1]).to.deepEqual(['store-b']);

    await controller.salesGst(user, undefined, '2026-10-01', '2026-10-02', undefined, undefined, 'Maharashtra');
    expect(captured[captured.length - 1]).to.deepEqual(['store-a', 'store-b']);

    global = true;
    await controller.salesGst(user, undefined, '2026-10-01', '2026-10-02');
    expect(captured[captured.length - 1]).to.deepEqual([
      'store-a',
      'store-b',
      'store-c',
    ]);

    await controller.salesGst(user, undefined, '2026-10-01', '2026-10-02', undefined, undefined, 'Maharashtra', 'store-c');
    expect(captured[captured.length - 1]).to.deepEqual(['store-c']);

    await controller.salesGst(user, undefined, '2026-10-01', '2026-10-02', undefined, undefined, 'Maharashtra', '');
    expect(captured[captured.length - 1]).to.deepEqual([]);
  });

  it('uses the caller scope for All Stores and intersects selected stores', async () => {
    global = false;
    await request();
    await request(undefined, 'store-a, store-c, store-b');
    expect(captured.slice(-2)).to.deepEqual([
      ['store-a', 'store-b'],
      ['store-a', 'store-b'],
    ]);
  });

  it('includes all stores for a global caller and keeps single-store requests working', async () => {
    global = true;
    await request();
    await request(undefined, 'store-c, store-a, store-c');
    await request('store-b');
    expect(captured.slice(-3)).to.deepEqual([
      ['store-a', 'store-b', 'store-c'],
      ['store-c', 'store-a'],
      ['store-b'],
    ]);
  });

  it('returns no stores when none of the selected stores are in scope', async () => {
    global = false;
    await request(undefined, 'store-c');
    expect(captured[captured.length - 1]).to.deepEqual([]);
  });

  it('rejects empty store IDs and conflicting store filters', async () => {
    for (const makeRequest of [
      () => request(undefined, 'store-a,'),
      () => request('store-a', 'store-b'),
    ]) {
      let error: {statusCode?: number} | undefined;
      try {
        await makeRequest();
      } catch (caught) {
        error = caught as {statusCode?: number};
      }
      expect(error?.statusCode).to.equal(400);
    }
  });
});
