import {expect} from '@loopback/testlab';
import {OrderService} from '../services/order.service';

describe('Manage Ticket invoice filter', () => {
  it('matches invoice numbers and consolidated links before pagination, within store scope', async () => {
    let scopedWhere: object | undefined;
    const queries: {sql: string; params: unknown[]}[] = [];
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        entityClass: {modelName: 'Order'},
      },
      dataSource: {
        connector: {
          buildWhere: (_model: string, where: object) => {
            scopedWhere = where;
            return {
              sql: 'WHERE isdeleted = ? AND storeid = ?',
              params: [false, 'store-1'],
            };
          },
          parameterize: (query: object) => query,
        },
        execute: async (sql: string, params: unknown[]) => {
          queries.push({sql, params});
          return sql.startsWith('SELECT count') ? [{count: 2}] : [];
        },
      },
    }) as OrderService;
    expect(
      await service.listOrders({
        invoiceNumber: ' ST008/069942 ',
        storeIds: ['store-1'],
        limit: 10,
        skip: 10,
      }),
    ).to.eql({rows: [], total: 2});
    expect(scopedWhere).to.eql({
      and: [{isDeleted: false}, {storeId: {inq: ['store-1']}}],
    });
    for (const query of queries) {
      expect(query.sql).to.containEql('public.invoice_order_link');
      expect(query.sql).to.containEql('isdeleted = ? AND storeid = ?');
      expect(query.sql).not.to.containEql('ST008/069942');
      expect(query.params.slice(0, 4)).to.eql([
        false,
        'store-1',
        '%ST008/069942%',
        '%ST008/069942%',
      ]);
    }
    expect(queries[0].params.slice(-2)).to.eql([10, 10]);
  });

  it('returns no tickets when an invoice number does not match', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      searchOrderPage: async () => [[], {count: 0}],
    }) as OrderService;
    expect(await service.listOrders({invoiceNumber: 'missing'})).to.eql({
      rows: [],
      total: 0,
    });
  });

  it('ignores an empty invoice search', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      orderRepo: {
        find: async (filter: {where: object}) => {
          expect(filter.where).to.eql({isDeleted: false});
          return [];
        },
        count: async () => ({count: 0}),
      },
    }) as OrderService;
    expect(await service.listOrders({invoiceNumber: '  '})).to.eql({
      rows: [],
      total: 0,
    });
  });

  it('passes the invoice filter into backend export queries', async () => {
    const service = Object.assign(Object.create(OrderService.prototype), {
      listOrders: async (params: {
        invoiceNumber?: string;
        storeIds?: string[];
      }) => {
        expect(params.invoiceNumber).to.equal('DLG11-1026-069943');
        expect(params.storeIds).to.eql(['store-1']);
        return {rows: [], total: 0};
      },
    }) as OrderService;
    expect(
      await service.exportOrders({invoiceNumber: 'DLG11-1026-069943'}, [
        'store-1',
      ]),
    ).to.eql({rows: [], total: 0});
  });
});
