import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('Manage Ticket server payment filtering', () => {
  it('applies payment filtering to page and count queries while retaining store scope', async () => {
    const queries: {sql: string; params: unknown[]}[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {entityClass: {modelName: 'Order'}},
      dataSource: {
        connector: {
          buildWhere: (_model: string, where: object) => {
            expect(where).to.eql({
              and: [{isDeleted: false}, {storeId: {inq: ['store-1']}}],
            });
            return {
              sql: 'WHERE isdeleted = ? AND storeid = ?',
              params: [false, 'store-1'],
            };
          },
          parameterize: (query: object) => query,
        },
        execute: async (sql: string, params: unknown[]) => {
          queries.push({sql, params});
          return [{count: 45, ids: []}];
        },
      },
    }) as OrderService;
    expect(
      await service.listOrders({
        paymentStatus: 'partial',
        storeIds: ['store-1'],
        limit: 10,
        skip: 50,
      }),
    ).to.eql({rows: [], total: 45});
    expect(queries).to.have.length(1);
    for (const query of queries) {
      expect(query.sql).to.containEql('payment_sums AS');
      expect(query.sql).to.containEql('payment_totals.collected > 0');
      expect(query.params.slice(0, 2)).to.eql([false, 'store-1']);
    }
    expect(queries[0].params.slice(-2)).to.eql([10, 50]);
  });

  it('rejects an unknown payment filter before querying', async () => {
    const service = Object.create(OrderService.prototype) as OrderService;
    await expect(
      service.listOrders({paymentStatus: "partial' OR TRUE --"}),
    ).to.be.rejectedWith('Unsupported payment status filter.');
  });

  it('pushes payment filters through every export batch without filtering paid aliases twice', async () => {
    let calls = 0;
    const service = Object.assign(Object.create(OrderService.prototype), {
      listOrders: async (params: {
        paymentStatus?: string;
        skip?: number;
        storeIds?: string[];
      }) => {
        expect(params.paymentStatus).to.equal('success');
        expect(params.storeIds).to.eql(['store-1']);
        expect(params.skip).to.equal(calls * 100);
        calls++;
        return {
          rows:
            calls === 1
              ? Array.from({length: 100}, () => ({paymentStatus: 'paid'}))
              : [{paymentStatus: 'paid'}],
        };
      },
    }) as OrderService;
    const result = await service.exportOrders({paymentStatus: 'success'}, [
      'store-1',
    ]);
    expect(result.total).to.equal(101);
    expect(calls).to.equal(2);
  });
});
