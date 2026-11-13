/* eslint-disable @typescript-eslint/no-explicit-any -- Partial service/repository doubles. */
import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';
import {ticketNumberPeriod} from '../utils/ticket-number';

function service(overrides: {tableExists: boolean; sequence?: string; storePrefix?: string; challanCount?: number}) {
  const calls: Array<{sql: string; params: unknown[]; options: unknown}> = [];
  const svc = Object.assign(Object.create(OrderService.prototype), {
    dataSource: {
      execute: async (sql: string, params: unknown[], options: unknown) => {
        calls.push({sql, params, options});
        if (sql.includes('to_regclass')) return [{ready: overrides.tableExists}];
        if (sql.includes('challan_number_sequence')) return [{sequence: overrides.sequence ?? '1'}];
        return [];
      },
    },
    storeRepo: {findOne: async () => ({storePrefix: overrides.storePrefix ?? 'PUKP1'})},
    challanRepo: {count: async () => ({count: overrides.challanCount ?? 0})},
  });
  return {svc: svc as any, calls};
}

// The "table exists" result is cached once true, so the fallback case runs first.
describe('challan numbers', () => {
  it('keeps the old numbering until the migration has created the counter table', async () => {
    const {svc} = service({tableExists: false, challanCount: 1887});
    expect(await svc.nextChallanNumber('store-1', {})).to.equal('CHL-001888');
  });

  it('numbers challans per store and month from the counter, inside the ticket transaction', async () => {
    const tx = {id: 'tx'};
    const {svc, calls} = service({tableExists: true, sequence: '7', storePrefix: 'PUKP1'});
    const {period, monthYear} = ticketNumberPeriod();
    expect(await svc.nextChallanNumber('store-1', tx)).to.equal(`CHL-PUKP1-${monthYear}-000007`);
    const upsert = calls.find(c => c.sql.includes('INSERT INTO public.challan_number_sequence'))!;
    expect(upsert.params).to.eql(['store-1', period]);
    expect(upsert.options).to.eql({transaction: tx});
  });

  it('gives tickets saved at the same moment different numbers', async () => {
    // Stands in for the database row: each upsert returns the next value.
    let last = 0;
    const svc = Object.assign(Object.create(OrderService.prototype), {
      dataSource: {execute: async (sql: string) => (sql.includes('to_regclass') ? [{ready: true}] : [{sequence: String(++last)}])},
      storeRepo: {findOne: async () => ({storePrefix: 'PUKP1'})},
      challanRepo: {count: async () => ({count: 0})},
    }) as any;
    const numbers = await Promise.all(Array.from({length: 20}, () => svc.nextChallanNumber('store-1', {})));
    expect(new Set(numbers).size).to.equal(20);
  });

  it('falls back to the old numbering for a store without a prefix', async () => {
    const {svc} = service({tableExists: true, storePrefix: '', challanCount: 41});
    expect(await svc.nextChallanNumber('store-1', {})).to.equal('CHL-000042');
  });
});
