/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from '@loopback/testlab';
import {StoreDashboardService} from '../services/store-dashboard.service';
import {dashboardAccess} from '../utils/dashboard-access';
import {securityId} from '@loopback/security';

const from = new Date('2026-11-01T00:00:00Z');
const to = new Date('2026-11-01T23:59:59Z');
const ROW = {collected: '300', tickets: 4, ticketamount: '1200.5', invoices: 2, invoiceamount: '900', pending: 0, deliveries: 0, accepted: 0};

function service(sqls: string[]) {
  return Object.assign(Object.create(StoreDashboardService.prototype), {
    shiftRepo: {findOne: async () => null},
    dataSource: {execute: async (sql: string) => { sqls.push(sql); return sql.includes('AS accepted') ? [ROW] : []; }},
  }) as StoreDashboardService;
}
const user = (permissions: string[]) => ({[securityId]: 'u', roles: ['store-manager-sm'], permissions: ['dashboard:read', ...permissions]}) as any;

describe('dashboard figure cards', () => {
  it('gives Super Admin all five figures', async () => {
    const access = dashboardAccess({[securityId]: 'u', roles: ['super_admin']} as any);
    const result: any = await service([]).window(['store-1'], {from, to}, 10, access);
    expect(result.kpis).to.deepEqual({collected: 300, tickets: 4, ticketAmount: 1200.5, invoices: 2, invoiceAmount: 900});
  });

  it('shows only the ticket figures with order:read', async () => {
    const result: any = await service([]).window(['store-1'], {from, to}, 10, dashboardAccess(user(['order:read'])));
    expect(result.kpis).to.deepEqual({tickets: 4, ticketAmount: 1200.5});
    expect(result.access).to.containEql({tickets: true, invoices: false, collected: false});
  });

  it('shows only the invoice and collection figures with invoice:read', async () => {
    const result: any = await service([]).window(['store-1'], {from, to}, 10, dashboardAccess(user(['invoice:read'])));
    expect(result.kpis).to.deepEqual({collected: 300, invoices: 2, invoiceAmount: 900});
  });

  it('counts sales only: no cancelled or draft tickets, issued invoices only', async () => {
    const sqls: string[] = [];
    await service(sqls).window(['store-1'], {from, to}, 10, dashboardAccess({[securityId]: 'u', roles: ['super_admin']} as any));
    const sql = sqls.find(s => s.includes('AS accepted'))!;
    expect(sql).to.match(/o\.status <> ALL\(/);
    expect(sql).to.match(/i\.status = \$\d+/);
    expect(sql).to.not.match(/isconsolidated/);
  });
});
