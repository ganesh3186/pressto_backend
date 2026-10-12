import {expect} from '@loopback/testlab';
import {UserProfile} from '@loopback/security';
import {ReportsController} from '../controllers/reports.controller';

describe('petty cash report store filters', () => {
  const user = {} as UserProfile;
  const captured: string[][] = [];
  let global = false;
  const controller = Object.assign(Object.create(ReportsController.prototype), {
    reportsService: {
      buildPettyCashExpense: async ({storeIds}: {storeIds: string[]}) => {
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
